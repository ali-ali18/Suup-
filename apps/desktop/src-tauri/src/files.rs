//! O arquivo que o bot entrega no chat (`send_file`; docs/API.md, "Arquivos que o bot entrega").
//!
//! Como toda requisição do app, o download sai daqui, pelo mesmo cliente e só para o servidor
//! configurado (`Net::check`). Os bytes não atravessam a ponte com a página: "Salvar" abre a janela
//! "Salvar como" do sistema e grava onde a pessoa escolheu; "Abrir" grava numa pasta do app
//! (cache, uma subpasta nova por arquivo) e abre com o programa padrão do sistema.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::Net;

/// O maior arquivo que o servidor entrega (25 MB), com folga para não cortar um no limite.
const MAX_BYTES: usize = 26 * 1024 * 1024;

/// Um nome que serve de arquivo em qualquer sistema: só o último pedaço, sem caracteres que o
/// Windows recusa nem de controle (troca por "_"). Caractere a caractere, sem padrão.
fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() || trimmed == ".." {
        "arquivo".to_string()
    } else {
        trimmed
    }
}

async fn download(net: &Net, url: &str, token: &str) -> Result<Vec<u8>, String> {
    let url = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    net.check(&url)?;
    let response = net
        .client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("o servidor respondeu {}", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("arquivo grande demais".into());
    }
    Ok(bytes.to_vec())
}

/// "Salvar": a janela do sistema com o nome do arquivo; `false` quando a pessoa a fechou.
#[tauri::command]
pub async fn file_save(
    app: AppHandle,
    net: State<'_, Net>,
    url: String,
    token: String,
    name: String,
) -> Result<bool, String> {
    // Baixa antes, para a janela não ficar esperando a rede depois da escolha.
    let bytes = download(&net, &url, &token).await?;
    // Um comando assíncrono roda fora da thread principal: a versão que espera é permitida.
    let Some(chosen) = app.dialog().file().set_file_name(safe_name(&name)).blocking_save_file()
    else {
        return Ok(false);
    };
    let path: PathBuf = chosen.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

/// "Abrir": grava numa pasta própria do app e abre com o programa padrão do sistema.
#[tauri::command]
pub async fn file_open(
    app: AppHandle,
    net: State<'_, Net>,
    url: String,
    token: String,
    name: String,
) -> Result<(), String> {
    let bytes = download(&net, &url, &token).await?;
    let mut unique = [0u8; 8];
    getrandom::fill(&mut unique).map_err(|e| e.to_string())?;
    let folder: String = unique.iter().map(|b| format!("{b:02x}")).collect();
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("arquivos")
        .join(folder);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe_name(&name));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn keeps_the_name_and_drops_what_a_file_system_refuses() {
        assert_eq!(safe_name("História da PUCPR.pdf"), "História da PUCPR.pdf");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("a\\b\\c:d?.txt"), "c_d_.txt");
        assert_eq!(safe_name(""), "arquivo");
        assert_eq!(safe_name(".."), "arquivo");
        assert_eq!(safe_name("nome.   "), "nome");
    }
}
