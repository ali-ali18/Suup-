//! A atualização do app (docs/ATUALIZACAO.md): o atualizador oficial do Tauri, só em Rust.
//!
//! - **Procura**: o `latest.json` da Release mais nova do GitHub (`plugins.updater.endpoints` no
//!   `tauri.conf.json`). A página não fala com a rede; ela só pede por estes comandos.
//! - **Confere**: o pacote baixado só é instalado se a assinatura bater com a chave pública do
//!   `tauri.conf.json` (o plugin não deixa desligar isso). Enquanto a chave for o marcador
//!   [`PLACEHOLDER_PUBKEY`], o atualizador fica desligado, sem erro para a pessoa.
//! - **Instala**: antes do instalador, o servidor embutido para com calma (o mesmo `stop` da saída
//!   do app): no Windows o plugin encerra o processo logo depois de abrir o instalador, sem passar
//!   pela saída normal. Se a instalação falhar, o servidor volta e o app segue na versão atual. O
//!   banco não é tocado; a versão nova aplica as migrações quando o servidor sobe de novo.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

use crate::local::{self, Local};

/// O que o `tauri.conf.json` traz no lugar da chave pública até o dono colar a dele.
pub const PLACEHOLDER_PUBKEY: &str = "SUBSTITUA-PELA-CHAVE-PUBLICA-DO-SUUP";

/// A versão encontrada e o pacote já baixado (e conferido) dela.
#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
    downloaded: Mutex<Option<(String, Vec<u8>)>>,
}

/// A chave pública configurada vale? (Comparação exata com o marcador; vazia também não vale.)
pub fn key_is_real(pubkey: Option<&str>) -> bool {
    match pubkey.map(str::trim) {
        Some(key) => !key.is_empty() && key != PLACEHOLDER_PUBKEY,
        None => false,
    }
}

fn configured_pubkey(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn enabled(app: &AppHandle) -> bool {
    key_is_real(configured_pubkey(app).as_deref())
}

/// O que não é "versão nova" nem falha: ainda não há Release publicada, ou a Release não traz o
/// pacote desta plataforma (o `.deb` do Linux, por exemplo). Comparado pelo tipo do erro.
fn means_nothing_new(error: &UpdaterError) -> bool {
    matches!(
        error,
        UpdaterError::ReleaseNotFound | UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_)
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    enabled: bool,
    current_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundUpdate {
    version: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum DownloadEvent {
    Progress { downloaded: u64, total: Option<u64> },
}

/// A versão deste app e se ele sabe se atualizar (a chave pública é a do dono).
#[tauri::command]
pub fn update_info(app: AppHandle) -> UpdateInfo {
    UpdateInfo {
        enabled: enabled(&app),
        current_version: app.package_info().version.to_string(),
    }
}

/// Procura uma versão mais nova. `None`: nada novo (ou o atualizador desligado).
#[tauri::command]
pub async fn update_check(app: AppHandle, updates: State<'_, Updates>) -> Result<Option<FoundUpdate>, String> {
    if !enabled(&app) {
        return Ok(None);
    }
    let checked = app.updater().map_err(|e| e.to_string())?.check().await;
    match checked {
        Ok(Some(update)) => {
            let version = update.version.clone();
            {
                let mut downloaded = updates.downloaded.lock().unwrap();
                if downloaded.as_ref().is_some_and(|(v, _)| *v != version) {
                    *downloaded = None;
                }
            }
            *updates.pending.lock().unwrap() = Some(update);
            Ok(Some(FoundUpdate { version }))
        }
        Ok(None) => Ok(None),
        Err(e) if means_nothing_new(&e) => Ok(None),
        Err(e) => {
            eprintln!("atualização: a procura falhou: {e}");
            Err(e.to_string())
        }
    }
}

/// Baixa a versão encontrada e confere a assinatura; o progresso vai pelo canal.
#[tauri::command]
pub async fn update_download(updates: State<'_, Updates>, on_event: Channel<DownloadEvent>) -> Result<(), String> {
    let update = updates
        .pending
        .lock()
        .unwrap()
        .clone()
        .ok_or("nenhuma versão nova foi encontrada")?;
    let mut downloaded: u64 = 0;
    let mut sent_at: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                // Um aviso a cada 256 KiB (e no fim) basta para a barra; não um por pedaço.
                if downloaded - sent_at >= 256 * 1024 || total == Some(downloaded) {
                    sent_at = downloaded;
                    let _ = on_event.send(DownloadEvent::Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| {
            eprintln!("atualização: o download falhou: {e}");
            e.to_string()
        })?;
    *updates.downloaded.lock().unwrap() = Some((update.version.clone(), bytes));
    Ok(())
}

/// Para o servidor embutido, instala e reabre o app. No Windows o instalador fecha o app e o abre de
/// novo; no macOS e no Linux o app reinicia daqui. Se falhar, o servidor volta e o erro sobe.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    updates: State<'_, Updates>,
    local: State<'_, Arc<Local>>,
) -> Result<(), String> {
    let update = updates
        .pending
        .lock()
        .unwrap()
        .clone()
        .ok_or("nenhuma versão nova foi encontrada")?;
    let bytes = match updates.downloaded.lock().unwrap().take() {
        Some((version, bytes)) if version == update.version => bytes,
        _ => return Err("a versão nova ainda não foi baixada".into()),
    };
    // Conferida de novo antes de parar qualquer coisa: um pacote ruim não derruba o servidor.
    if let Err(e) = update.verify(&bytes) {
        eprintln!("atualização: a assinatura não confere: {e}");
        return Err(e.to_string());
    }
    let was_running = local.is_wanted();
    local::stop(&local, local::GRACEFUL_STOP).await;
    match update.install(&bytes) {
        Ok(()) => app.restart(),
        Err(e) => {
            eprintln!("atualização: a instalação falhou: {e}");
            if was_running {
                local::start(&app, &local);
            }
            *updates.downloaded.lock().unwrap() = Some((update.version.clone(), bytes));
            Err(e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_placeholder_and_an_empty_key_turn_the_updater_off() {
        assert!(!key_is_real(None));
        assert!(!key_is_real(Some("")));
        assert!(!key_is_real(Some("   ")));
        assert!(!key_is_real(Some(PLACEHOLDER_PUBKEY)));
        assert!(key_is_real(Some("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk=")));
    }

    #[test]
    fn the_config_carries_the_placeholder_until_the_owner_pastes_his_key() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert_eq!(updater["pubkey"].as_str(), Some(PLACEHOLDER_PUBKEY));
        assert_eq!(
            updater["endpoints"][0].as_str(),
            Some("https://github.com/ali-ali18/suup-/releases/latest/download/latest.json")
        );
        // Sem o segredo da assinatura a compilação comum não gera pacotes de atualização.
        assert!(config["bundle"].get("createUpdaterArtifacts").is_none());
    }

    #[test]
    fn a_missing_release_or_platform_is_nothing_new_and_a_network_error_is_a_failure() {
        assert!(means_nothing_new(&UpdaterError::ReleaseNotFound));
        assert!(means_nothing_new(&UpdaterError::TargetNotFound("windows-x86_64".into())));
        assert!(means_nothing_new(&UpdaterError::TargetsNotFound(vec![])));
        assert!(!means_nothing_new(&UpdaterError::Network("x".into())));
    }
}
