//! O servidor que o app carrega ("Usar neste computador"): o banco, o servidor e o worker rodam
//! num processo filho (o *sidecar*: o Node que acompanha o app, com o pacote JavaScript), que este
//! módulo inicia, vigia e encerra.
//!
//! - **Segredos**: a senha do banco, o token de acesso, a chave do cofre e a chave do provedor de
//!   modelos ficam no chaveiro do sistema (Credential Manager, Keychain, Secret Service) e vão ao
//!   filho só por variável de ambiente. Nada disso vai a arquivo, ao registro ou à página.
//! - **Vida**: sobe com o app, para com calma ao sair (o filho recebe `stop` pela entrada padrão e,
//!   se o app morrer, o fim da entrada faz o mesmo: o banco nunca fica órfão). Se cair, reinicia
//!   com espera crescente e para depois de poucas tentativas, dizendo o motivo.
//! - **Estado**: `local_status` devolve o que a tela mostra (etapa, motivo, isolamento, tentativa).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::Net;

const KEYRING_SERVICE: &str = "app.suup.desktop";
const SECRET_PG: &str = "local-pg-password";
const SECRET_TOKEN: &str = "local-server-token";
const SECRET_VAULT: &str = "local-vault-key";
const SECRET_API_KEY: &str = "anthropic-api-key";

/// Tentativas seguidas antes de desistir, e a espera máxima entre elas.
const MAX_FAILURES: u32 = 5;
const MAX_BACKOFF_SECS: u64 = 30;
/// Um filho que ficou de pé tanto tempo zera a contagem de falhas.
const STABLE_AFTER: Duration = Duration::from_secs(60);
/// Quanto esperar o filho parar com calma ao sair (as execuções em andamento voltam à fila).
const GRACEFUL_STOP: Duration = Duration::from_secs(40);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Isolation {
    mode: String,
    reason: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    /// idle, starting, ready, restarting, failed, stopping
    state: String,
    stage: Option<String>,
    message: Option<String>,
    url: Option<String>,
    isolation: Option<Isolation>,
    attempt: u32,
    restart_in_seconds: Option<u64>,
    has_api_key: bool,
    logs_dir: String,
}

struct Inner {
    status: LocalStatus,
    child: Option<CommandChild>,
    /// Quer o servidor de pé? (falso: parado de propósito.)
    want: bool,
    /// Cada partida do supervisor tem um número; um supervisor velho se aposenta sozinho.
    generation: u64,
    /// O filho está vivo (entre o início e o `Terminated`).
    alive: bool,
}

pub struct Local {
    inner: Mutex<Inner>,
    exiting: AtomicBool,
}

impl Local {
    pub fn new() -> Arc<Self> {
        Arc::new(Local {
            inner: Mutex::new(Inner {
                status: LocalStatus {
                    state: "idle".into(),
                    stage: None,
                    message: None,
                    url: None,
                    isolation: None,
                    attempt: 0,
                    restart_in_seconds: None,
                    has_api_key: false,
                    logs_dir: String::new(),
                },
                child: None,
                want: false,
                generation: 0,
                alive: false,
            }),
            exiting: AtomicBool::new(false),
        })
    }

    fn update(&self, f: impl FnOnce(&mut Inner)) {
        f(&mut self.inner.lock().unwrap());
    }

    fn snapshot(&self) -> LocalStatus {
        self.inner.lock().unwrap().status.clone()
    }

    /// O app está saindo e o filho ainda precisa de uns instantes para parar.
    pub fn needs_shutdown(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.alive || inner.child.is_some()
    }
}

// ---- chaveiro e pastas ----------------------------------------------------------------------

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, name)
        .map_err(|e| format!("não foi possível usar o chaveiro do sistema: {e}"))
}

fn read_secret(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("não foi possível ler do chaveiro do sistema: {e}")),
    }
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|e| format!("sem números aleatórios do sistema: {e}"))?;
    Ok(bytes)
}

/// A senha, o token e a chave do cofre: gerados na primeira vez, e depois só lidos.
fn get_or_create(name: &str, make: impl FnOnce() -> Result<String, String>) -> Result<String, String> {
    if let Some(value) = read_secret(name)? {
        return Ok(value);
    }
    let value = make()?;
    entry(name)?
        .set_password(&value)
        .map_err(|e| format!("não foi possível guardar no chaveiro do sistema: {e}"))?;
    Ok(value)
}

fn url_safe(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn local_secrets() -> Result<HashMap<String, String>, String> {
    let mut env = HashMap::new();
    env.insert(
        "SUUP_PG_PASSWORD".to_string(),
        get_or_create(SECRET_PG, || Ok(url_safe(&random_bytes::<24>()?)))?,
    );
    env.insert(
        "SUUP_SERVER_TOKEN".to_string(),
        get_or_create(SECRET_TOKEN, || Ok(url_safe(&random_bytes::<32>()?)))?,
    );
    env.insert(
        "SUUP_VAULT_KEY".to_string(),
        get_or_create(SECRET_VAULT, || {
            Ok(base64::engine::general_purpose::STANDARD.encode(random_bytes::<32>()?))
        })?,
    );
    if let Some(key) = read_secret(SECRET_API_KEY)? {
        env.insert("ANTHROPIC_API_KEY".to_string(), key);
    }
    Ok(env)
}

/// O Windows devolve caminhos com o prefixo `\\?\`, que o PostgreSQL não entende ao achar os
/// próprios arquivos: tira.
fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    match text.strip_prefix("\\\\?\\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// Os dados do servidor local ficam na pasta de dados LOCAL do usuário (no Windows, `%LOCALAPPDATA%`:
/// a pasta Roaming pode ser sincronizada pela rede, e um banco não deve ir junto).
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = plain_path(app.path().app_local_data_dir().map_err(|e| e.to_string())?).join("local");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn resources_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(plain_path(app.path().resource_dir().map_err(|e| e.to_string())?).join("resources"))
}

// ---- o supervisor ------------------------------------------------------------------------------

fn apply_event(app: &AppHandle, local: &Local, value: &Value, last_error: &mut Option<String>) {
    match value.get("event").and_then(Value::as_str) {
        Some("stage") => {
            let stage = value.get("stage").and_then(Value::as_str).map(str::to_string);
            local.update(|i| {
                i.status.state = "starting".into();
                i.status.stage = stage;
            });
        }
        Some("ready") => {
            let url = value.get("url").and_then(Value::as_str).map(str::to_string);
            let isolation = value.get("isolation").map(|iso| Isolation {
                mode: iso.get("mode").and_then(Value::as_str).unwrap_or("local").to_string(),
                reason: iso.get("reason").and_then(Value::as_str).map(str::to_string),
                detail: iso.get("detail").and_then(Value::as_str).map(str::to_string),
            });
            if let Some(url) = url.as_deref().and_then(|u| reqwest::Url::parse(u).ok()) {
                app.state::<Net>().allow(&url);
            }
            local.update(|i| {
                i.status.state = "ready".into();
                i.status.stage = None;
                i.status.message = None;
                i.status.restart_in_seconds = None;
                i.status.url = url;
                i.status.isolation = isolation;
            });
        }
        Some("error") => {
            *last_error = value.get("message").and_then(Value::as_str).map(str::to_string);
        }
        _ => {}
    }
}

/// Uma vida do filho: inicia, lê o que ele conta, devolve quando ele termina.
async fn run_child(
    app: &AppHandle,
    local: &Arc<Local>,
    generation: u64,
    last_error: &mut Option<String>,
) -> Result<(Option<i32>, Instant), String> {
    let data = data_dir(app)?;
    let resources = resources_dir(app)?;
    let mut env = local_secrets()?;
    env.insert("SUUP_APP_DATA".into(), data.to_string_lossy().to_string());
    env.insert("SUUP_RESOURCES".into(), resources.to_string_lossy().to_string());
    env.insert("SUUP_APP_VERSION".into(), env!("CARGO_PKG_VERSION").to_string());
    let bundle = resources.join("sidecar").join("sidecar.mjs");
    let (mut rx, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("o Node que acompanha o app não foi achado: {e}"))?
        .args([bundle.to_string_lossy().to_string()])
        .envs(env)
        .current_dir(data.clone())
        .spawn()
        .map_err(|e| format!("não foi possível iniciar o servidor local: {e}"))?;
    local.update(|i| {
        i.child = Some(child);
        i.alive = true;
        i.status.logs_dir = data.join("logs").to_string_lossy().to_string();
    });
    let started = Instant::now();
    let mut stderr_tail: Vec<String> = Vec::new();
    let mut code = None;
    let mut pending = String::new();
    while let Some(event) = rx.recv().await {
        if local.inner.lock().unwrap().generation != generation {
            break;
        }
        match event {
            CommandEvent::Stdout(bytes) => {
                pending.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(at) = pending.find('\n') {
                    let line: String = pending.drain(..=at).collect();
                    if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                        apply_event(app, local, &value, last_error);
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                for line in String::from_utf8_lossy(&bytes).lines() {
                    stderr_tail.push(line.to_string());
                    if stderr_tail.len() > 8 {
                        stderr_tail.remove(0);
                    }
                }
            }
            CommandEvent::Error(message) => stderr_tail.push(message),
            CommandEvent::Terminated(payload) => {
                code = payload.code;
                break;
            }
            _ => {}
        }
    }
    local.update(|i| {
        i.alive = false;
        i.child = None;
    });
    if last_error.is_none() && !stderr_tail.is_empty() {
        *last_error = Some(stderr_tail.join(" | "));
    }
    Ok((code, started))
}

async fn supervise(app: AppHandle, local: Arc<Local>, generation: u64) {
    let mut failures: u32 = 0;
    loop {
        let wanted = |l: &Local| {
            let i = l.inner.lock().unwrap();
            i.want && i.generation == generation
        };
        if !wanted(&local) {
            break;
        }
        local.update(|i| {
            i.status.state = "starting".into();
            i.status.stage = None;
            i.status.url = None;
            i.status.attempt += 1;
            i.status.restart_in_seconds = None;
        });
        let mut last_error: Option<String> = None;
        let outcome = run_child(&app, &local, generation, &mut last_error).await;
        if !wanted(&local) {
            local.update(|i| {
                if i.generation == generation {
                    i.status.state = "idle".into();
                    i.status.stage = None;
                    i.status.url = None;
                }
            });
            break;
        }
        let reason = match outcome {
            Ok((code, started)) => {
                if started.elapsed() > STABLE_AFTER {
                    failures = 0;
                }
                last_error.unwrap_or_else(|| match code {
                    Some(c) => format!("o servidor local terminou (código {c})"),
                    None => "o servidor local foi encerrado".to_string(),
                })
            }
            // Sem chaveiro, sem Node: tentar de novo não adianta.
            Err(message) => {
                local.update(|i| {
                    i.status.state = "failed".into();
                    i.status.message = Some(message);
                });
                break;
            }
        };
        failures += 1;
        if failures >= MAX_FAILURES {
            local.update(|i| {
                i.status.state = "failed".into();
                i.status.message = Some(format!("{reason} (desisti depois de {failures} tentativas)"));
            });
            break;
        }
        let wait = (1u64 << (failures - 1)).min(MAX_BACKOFF_SECS);
        for left in (1..=wait).rev() {
            local.update(|i| {
                i.status.state = "restarting".into();
                i.status.message = Some(reason.clone());
                i.status.restart_in_seconds = Some(left);
            });
            tokio::time::sleep(Duration::from_secs(1)).await;
            if !wanted(&local) {
                return;
            }
        }
    }
}

/// Liga o servidor (ou o religa): o supervisor anterior, se houver, se aposenta.
pub fn start(app: &AppHandle, local: &Arc<Local>) {
    let generation = {
        let mut i = local.inner.lock().unwrap();
        i.generation += 1;
        i.want = true;
        i.status.attempt = 0;
        i.status.message = None;
        i.status.has_api_key = read_secret(SECRET_API_KEY).ok().flatten().is_some();
        i.generation
    };
    tauri::async_runtime::spawn(supervise(app.clone(), local.clone(), generation));
}

/// Para o servidor com calma: pede `stop`, espera `grace`, e só então mata.
pub async fn stop(local: &Arc<Local>, grace: Duration) {
    local.update(|i| {
        i.want = false;
        i.generation += 1;
        if i.alive {
            i.status.state = "stopping".into();
        }
        if let Some(child) = i.child.as_mut() {
            let _ = child.write(b"stop\n");
        }
    });
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline && local.inner.lock().unwrap().alive {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let child = local.inner.lock().unwrap().child.take();
    if let Some(child) = child {
        let _ = child.kill();
    }
    local.update(|i| {
        i.alive = false;
        i.status.state = "idle".into();
        i.status.stage = None;
        i.status.url = None;
    });
}

/// Ao sair do app: para o filho e só então deixa o app terminar.
pub fn shutdown_on_exit(app: &AppHandle, local: &Arc<Local>) -> bool {
    if !local.needs_shutdown() || local.exiting.swap(true, Ordering::SeqCst) {
        return false;
    }
    let app = app.clone();
    let local = local.clone();
    tauri::async_runtime::spawn(async move {
        stop(&local, GRACEFUL_STOP).await;
        app.exit(0);
    });
    true
}

/// Na abertura do app: se este dispositivo usa o servidor local, ele sobe junto.
pub fn start_if_selected(app: &AppHandle, local: &Arc<Local>) {
    if crate::mode_of(app).as_deref() == Some("local") {
        start(app, local);
    }
}

// ---- comandos ------------------------------------------------------------------------------------

#[tauri::command]
pub fn local_status(local: State<'_, Arc<Local>>) -> LocalStatus {
    local.snapshot()
}

#[tauri::command]
pub fn local_select(app: AppHandle, local: State<'_, Arc<Local>>) -> Result<(), String> {
    crate::set_mode(&app, "local")?;
    start(&app, &local);
    Ok(())
}

#[tauri::command]
pub fn local_start(app: AppHandle, local: State<'_, Arc<Local>>) {
    start(&app, &local);
}

#[tauri::command]
pub async fn local_stop(local: State<'_, Arc<Local>>) -> Result<(), String> {
    stop(&local, GRACEFUL_STOP).await;
    Ok(())
}

/// O endereço e o token do servidor local, para o app se conectar (e só ele se conecta).
#[tauri::command]
pub fn local_connection(
    net: State<'_, Net>,
    local: State<'_, Arc<Local>>,
) -> Result<crate::Connection, String> {
    let url = local.snapshot().url.ok_or("o servidor local ainda não está pronto")?;
    let token = read_secret(SECRET_TOKEN)?.ok_or("o token do servidor local não está no chaveiro")?;
    net.allow(&reqwest::Url::parse(&url).map_err(|e| e.to_string())?);
    Ok(crate::Connection { server_url: url, token })
}

/// Guarda a chave do provedor de modelos no chaveiro; um servidor em pé reinicia para usá-la.
/// A chave só passa por aqui: não é registrada, nem devolvida.
#[tauri::command]
pub async fn local_set_api_key(
    app: AppHandle,
    local: State<'_, Arc<Local>>,
    key: String,
) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("a chave está vazia".into());
    }
    entry(SECRET_API_KEY)?
        .set_password(&key)
        .map_err(|e| format!("não foi possível guardar no chaveiro do sistema: {e}"))?;
    local.update(|i| i.status.has_api_key = true);
    let running = local.inner.lock().unwrap().want;
    if running {
        stop(&local, GRACEFUL_STOP).await;
        start(&app, &local);
    }
    Ok(())
}

#[tauri::command]
pub fn local_open_logs(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?.join("logs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}
