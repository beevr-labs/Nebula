//! Nebula Rust backend — privileged operations behind a Vault allow-list.
//! Command signatures mirror API-CONTRACTS.md §1. Each `todo!()` is a task in BACKLOG.md.
//! RULE (CODING-STANDARDS §3/§4): no `unwrap()` on fallible I/O; every error maps to a
//! code in the error catalog; all disk access goes through `fs_scope` (NFR-SEC-003).

mod fs_scope; // Vault allow-list (T-002)
mod model_manager; // download/verify/cache/select (T-043/044/045/060)
mod capability; // WebGPU/RAM/disk + chat-readiness (T-040/049)
mod logger; // opt-in metadata-only logs (T-065)

use serde::{Deserialize, Serialize};

/// Maps to the shared error catalog (API-CONTRACTS §4).
#[derive(Debug, thiserror::Error, Serialize)]
pub enum NebulaError {
    #[error("OUTSIDE_VAULT")]
    OutsideVault,
    #[error("UNSUPPORTED")]
    Unsupported,
    #[error("MODEL_HASH")]
    ModelHash,
    #[error("IO: {0}")]
    Io(String),
}

#[derive(Serialize)]
pub struct Capabilities {
    pub webgpu: bool,
    pub ram_gb: f32,
    pub vram_gb: Option<f32>,
    pub free_disk_gb: f32,
    pub selected_provider: String, // "webllm" | "native-rust" | "none"
    pub tier: String,              // "full" | "degraded"  (FR-CAP-002)
    pub chat_status: String,       // "ready" | "needs_model" | "unsupported" (FR-CAP-004)
    pub active_model_id: Option<String>,
}

// --- Tauri commands (UI -> Rust). See API-CONTRACTS §1. ---

#[tauri::command]
fn fs_read_file(_path: String) -> Result<Vec<u8>, NebulaError> {
    // fs_scope::read(&path)  — rejects paths outside the Vault (TC-SEC-002)
    todo!("T-002")
}

#[tauri::command]
fn fs_write_note(_path: String, _content: String) -> Result<(), NebulaError> {
    todo!("T-002 / T-005")
}

#[tauri::command]
fn capability_check() -> Result<Capabilities, NebulaError> {
    // capability::probe() — drives provider selection + chat_status (FR-CAP-001/004)
    todo!("T-040 / T-049")
}

#[tauri::command]
async fn model_download(_model_id: String) -> Result<(), NebulaError> {
    // resumable (HTTP Range) + emit 'model_progress' (FR-MDL-001)
    todo!("T-043")
}

#[tauri::command]
fn model_verify(_model_id: String) -> Result<bool, NebulaError> {
    // sha2 vs models.manifest.json (FR-MDL-002)
    todo!("T-044")
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            fs_read_file,
            fs_write_note,
            capability_check,
            model_download,
            model_verify
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nebula");
}
