//! A casca nativa do Suup: uma janela, o token no chaveiro do sistema, a configuração em arquivo e
//! a ÚNICA porta de saída de rede do app.
//!
//! A página (a interface web) não fala com a rede: a CSP dela (`tauri.conf.json`) só permite o canal
//! interno do Tauri (`ipc:`). Toda requisição ao servidor passa por `http_fetch`, que só aceita o
//! endereço (esquema, host e porta) que a pessoa configurou. Assim a lista de origens permitidas é
//! decidida em tempo de execução, o que uma CSP estática não consegue, e nenhuma outra origem é
//! alcançável, nem por uma falha na página.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

const KEYRING_SERVICE: &str = "app.suup.desktop";
const KEYRING_USER: &str = "server-token";

/// O estado de rede: o único servidor permitido e as requisições em andamento.
struct Net {
    client: reqwest::Client,
    allowed_origin: Mutex<Option<String>>,
    aborts: Mutex<HashMap<u64, oneshot::Sender<()>>>,
}

impl Net {
    fn new() -> Self {
        Net {
            // Sem redirecionamentos: um redirecionamento poderia levar a outra origem.
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("cliente HTTP"),
            allowed_origin: Mutex::new(None),
            aborts: Mutex::new(HashMap::new()),
        }
    }

    fn allow(&self, url: &reqwest::Url) {
        *self.allowed_origin.lock().unwrap() = Some(url.origin().ascii_serialization());
    }

    fn forget(&self) {
        *self.allowed_origin.lock().unwrap() = None;
    }

    /// A URL tem de ser do servidor configurado, e só http ou https.
    fn check(&self, url: &reqwest::Url) -> Result<(), String> {
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err("esquema não permitido".into());
        }
        match &*self.allowed_origin.lock().unwrap() {
            Some(origin) if *origin == url.origin().ascii_serialization() => Ok(()),
            _ => Err("endereço fora do servidor configurado".into()),
        }
    }
}

fn parse_server_url(text: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(text).map_err(|e| format!("endereço inválido: {e}"))?;
    if (url.scheme() != "http" && url.scheme() != "https") || url.host_str().is_none() {
        return Err("o endereço precisa começar com http:// ou https://".into());
    }
    Ok(url)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    server_url: String,
    token: String,
}

/// O que fica no arquivo de configuração: o modo (`local` ou `vps`) e, no modo `vps`, o endereço.
/// Um arquivo de antes do modo (só o endereço) vale como `vps`.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    #[serde(default)]
    server_url: Option<String>,
    #[serde(default)]
    mode: Option<String>,
}

fn read_config(app: &AppHandle) -> StoredConfig {
    config_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<StoredConfig>(&text).ok())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, config: &StoredConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(config_path(app)?, text).map_err(|e| e.to_string())
}

fn effective_mode(config: &StoredConfig) -> Option<String> {
    match (&config.mode, &config.server_url) {
        (Some(mode), _) => Some(mode.clone()),
        (None, Some(_)) => Some("vps".into()),
        (None, None) => None,
    }
}

/// O servidor que este dispositivo usa: `local`, `vps` ou nada (a primeira abertura).
#[tauri::command]
fn mode_load(app: AppHandle) -> Option<String> {
    effective_mode(&read_config(&app))
}

#[tauri::command]
fn mode_save(app: AppHandle, mode: String) -> Result<(), String> {
    if mode != "local" && mode != "vps" {
        return Err("modo desconhecido".into());
    }
    let mut config = read_config(&app);
    config.mode = Some(mode);
    write_config(&app, &config)
}

/// Esquece a escolha (e o endereço): a próxima abertura pergunta de novo.
#[tauri::command]
fn mode_clear(app: AppHandle) -> Result<(), String> {
    write_config(&app, &StoredConfig::default())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

/// O endereço (arquivo de configuração) e o token (chaveiro) guardados, se houver os dois.
#[tauri::command]
fn connection_load(app: AppHandle, net: State<'_, Net>) -> Result<Option<Connection>, String> {
    let path = config_path(&app)?;
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    let Ok(config) = serde_json::from_str::<StoredConfig>(&text) else {
        return Ok(None);
    };
    if effective_mode(&config).as_deref() != Some("vps") {
        return Ok(None);
    }
    let Some(server_url) = config.server_url else {
        return Ok(None);
    };
    let Ok(token) = keyring_entry()?.get_password() else {
        return Ok(None);
    };
    net.allow(&parse_server_url(&server_url)?);
    Ok(Some(Connection { server_url, token }))
}

/// Libera o servidor que a pessoa acabou de digitar, para o teste da conexão (antes de guardar).
#[tauri::command]
fn connection_allow(net: State<'_, Net>, server_url: String) -> Result<(), String> {
    net.allow(&parse_server_url(&server_url)?);
    Ok(())
}

#[tauri::command]
fn connection_save(app: AppHandle, net: State<'_, Net>, server_url: String, token: String) -> Result<(), String> {
    let url = parse_server_url(&server_url)?;
    keyring_entry()?.set_password(&token).map_err(|e| e.to_string())?;
    let mut config = read_config(&app);
    config.server_url = Some(server_url);
    config.mode = Some("vps".into());
    write_config(&app, &config)?;
    net.allow(&url);
    Ok(())
}

#[tauri::command]
fn connection_clear(app: AppHandle, net: State<'_, Net>) -> Result<(), String> {
    // Apagar o que não existe não é erro.
    let _ = keyring_entry().and_then(|e| e.delete_credential().map_err(|e| e.to_string()));
    let mut config = read_config(&app);
    config.server_url = None;
    write_config(&app, &config)?;
    net.forget();
    Ok(())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// As configurações de aparência (JSON; o app as valida ao ler): por instalação, nunca no servidor.
#[tauri::command]
fn settings_load(app: AppHandle) -> Result<Option<String>, String> {
    match fs::read_to_string(settings_path(&app)?) {
        Ok(text) => Ok(Some(text)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn settings_save(app: AppHandle, json: String) -> Result<(), String> {
    // Um limite só para não gravar lixo enorme: as configurações são poucas linhas.
    if json.len() > 16 * 1024 {
        return Err("configurações grandes demais".into());
    }
    fs::write(settings_path(&app)?, json).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
enum FetchEvent {
    Head { status: u16, status_text: String, headers: Vec<(String, String)> },
    Chunk { data: Vec<u8> },
    End,
    Error { message: String },
}

async fn run_request(req: reqwest::RequestBuilder, on_event: &Channel<FetchEvent>) -> Result<(), String> {
    let response = req.send().await.map_err(|e| e.to_string())?;
    let headers = response
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), v.to_string())))
        .collect();
    on_event
        .send(FetchEvent::Head {
            status: response.status().as_u16(),
            status_text: response.status().canonical_reason().unwrap_or("").to_string(),
            headers,
        })
        .map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => on_event.send(FetchEvent::Chunk { data: bytes.to_vec() }).map_err(|e| e.to_string())?,
            Err(e) => {
                let _ = on_event.send(FetchEvent::Error { message: e.to_string() });
                return Ok(());
            }
        }
    }
    on_event.send(FetchEvent::End).map_err(|e| e.to_string())
}

/// `fetch`, em Rust: só para o servidor configurado, com o corpo da resposta em pedaços (o fluxo de
/// tempo real é uma resposta que nunca termina).
#[tauri::command]
async fn http_fetch(
    net: State<'_, Net>,
    id: u64,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    on_event: Channel<FetchEvent>,
) -> Result<(), String> {
    let url = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    net.check(&url)?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut request = net.client.request(method, url);
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if lower == "host" || lower == "content-length" || lower == "origin" {
            continue;
        }
        request = request.header(name, value);
    }
    if let Some(text) = body {
        request = request.body(text);
    }
    let (abort_tx, mut abort_rx) = oneshot::channel::<()>();
    net.aborts.lock().unwrap().insert(id, abort_tx);
    let result = tokio::select! {
        r = run_request(request, &on_event) => r,
        _ = &mut abort_rx => Err("abortada".to_string()),
    };
    net.aborts.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
fn http_abort(net: State<'_, Net>, id: u64) {
    if let Some(tx) = net.aborts.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

/// Abre um link fora do app (o navegador do sistema). Só http, https e mailto.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("esquema não permitido".into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Net::new())
        .invoke_handler(tauri::generate_handler![
            connection_load,
            connection_allow,
            connection_save,
            connection_clear,
            mode_load,
            mode_save,
            mode_clear,
            settings_load,
            settings_save,
            http_fetch,
            http_abort,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Suup");
}
