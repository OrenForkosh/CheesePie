use std::sync::Mutex;

use tauri::State;

struct PendingFiles(Mutex<Vec<String>>);

#[tauri::command]
fn take_pending_files(state: State<PendingFiles>) -> Vec<String> {
    let mut guard = state.0.lock().expect("pending files lock");
    let files = guard.clone();
    guard.clear();
    files
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    tauri::Builder::default()
        .manage(PendingFiles(Mutex::new(args)))
        .invoke_handler(tauri::generate_handler![take_pending_files])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
