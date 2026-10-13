use libp2p::{identity::Keypair, PeerId};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::State;

struct AppState {
    db: Arc<Mutex<Connection>>,
    p2p: Arc<Mutex<P2PStatus>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct WorkspaceDocument {
    id: String,
    name: String,
    kind: String,
    content: String,
    updated_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Task {
    id: String,
    title: String,
    due_date: Option<String>,
    done: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct P2PStatus {
    local_peer_id: String,
    peer_count: usize,
    mode: String,
}

fn initialize_database(db: &Connection) -> Result<(), String> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            due_date TEXT,
            done INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            content TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )
    .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
fn list_tasks(state: State<'_, AppState>) -> Result<Vec<Task>, String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    let mut statement = db
        .prepare("SELECT id, title, due_date, done FROM tasks ORDER BY due_date, title")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(Task {
                id: row.get(0)?,
                title: row.get(1)?,
                due_date: row.get(2)?,
                done: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_task(task: Task, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO tasks (id, title, due_date, done) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, due_date=excluded.due_date, done=excluded.done",
        params![task.id, task.title, task.due_date, i64::from(task.done)],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_documents(state: State<'_, AppState>) -> Result<Vec<WorkspaceDocument>, String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    let mut statement = db
        .prepare("SELECT id, name, kind, content, updated_at FROM documents ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(WorkspaceDocument {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                content: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_document(document: WorkspaceDocument, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO documents (id, name, kind, content, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, content=excluded.content, updated_at=excluded.updated_at",
        params![
            document.id,
            document.name,
            document.kind,
            document.content,
            document.updated_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_collaboration_status(state: State<'_, AppState>) -> Result<P2PStatus, String> {
    let status = state.p2p.lock().map_err(|error| error.to_string())?;
    Ok(status.clone())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = Connection::open(data_dir.join("northstar.db"))?;
            initialize_database(&db)?;

            let keypair = Keypair::generate_ed25519();
            let peer_id = PeerId::from(&keypair).to_string();
            let p2p_status = P2PStatus {
                local_peer_id: peer_id,
                peer_count: 0,
                mode: "mdns + gossipsub".to_string(),
            };

            app.manage(AppState {
                db: Arc::new(Mutex::new(db)),
                p2p: Arc::new(Mutex::new(p2p_status)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_tasks,
            save_task,
            list_documents,
            save_document,
            get_collaboration_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Northstar Workspace");
}