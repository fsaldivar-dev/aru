// ARU Studio desktop shell. The editor is the same web Studio (copied to ../dist); Rust only provides:
//   - the agents bridge: detect / run / cancel the AI CLIs installed on this machine (claude, codex, agy, gemini)
//   - plain text file read/write for the native open/save dialogs (tauri-plugin-dialog)
//
// Security model of the bridge (same as tools/agents-bridge.mjs):
//   - only four known executables, resolved by name in the user's login-shell PATH + usual install dirs
//     (apps opened from Finder start with a minimal PATH)
//   - their command lines are built HERE from fixed templates; the page supplies only text (system prompt, prompt),
//     a JSON schema and a model name (validated)
//   - each run happens in its own temporary directory, with a timeout, and can be cancelled
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use base64::Engine as _;
use tauri::State;

const AGENTS: [(&str, &str, &str); 4] = [("claude", "Claude", "claude"), ("codex", "Codex", "codex"), ("agy", "Antigravity", "agy"), ("gemini", "Gemini", "gemini")];
const TIMEOUT: Duration = Duration::from_secs(6 * 60);

#[derive(Serialize, Clone)]
struct Agent { id: String, name: String, bin: String, installed: bool, path: Option<String>, version: Option<String>, models: Vec<AgentModel>, #[serde(rename="modelSource")] model_source: String }

#[derive(Serialize, Clone)]
struct AgentModel { id: String, label: String }
fn catalog_models(cache: &serde_json::Value) -> Vec<AgentModel> {
    let mut seen=HashSet::new();
    cache.get("models").and_then(|v|v.as_array()).map(|items|items.iter().filter_map(|m|{
        let id=m.get("slug")?.as_str()?;
        if m.get("visibility").and_then(|v|v.as_str())!=Some("list") || id.is_empty() || id.len()>64 || !id.chars().all(|c|c.is_ascii_alphanumeric() || "._:/-".contains(c)) || !seen.insert(id.to_string()) {return None;}
        Some(AgentModel{id:id.into(),label:m.get("display_name").and_then(|v|v.as_str()).unwrap_or(id).into()})
    }).collect()).unwrap_or_default()
}
fn model_metadata(mut agent: Agent) -> Agent {
    if agent.id=="codex" {
        let home=std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(||std::env::var_os("HOME").map(|h|PathBuf::from(h).join(".codex")));
        if let Some(cache)=home.and_then(|h|fs::read_to_string(h.join("models_cache.json")).ok()).and_then(|s|serde_json::from_str::<serde_json::Value>(&s).ok()) {
            agent.models=catalog_models(&cache);
            if !agent.models.is_empty() {agent.model_source="local-cache".into();}
        }
    }
    agent
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunReq { provider: String, model: Option<String>, system: String, prompt: String, schema: serde_json::Value, run_id: Option<String>, #[serde(default)] images: Vec<Image> }

#[derive(Deserialize)]
struct Image { name: String, mime: String, data: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunRes { ok: bool, code: i32, cancelled: bool, stdout: String, stderr: String, output: Option<String>, ms: u64, run_id: String }

struct Bridge { path: Vec<PathBuf>, running: Mutex<HashMap<String, u32>>, cancelled: Mutex<HashSet<String>>, detected: Mutex<Option<Vec<Agent>>> }

fn login_path() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| { if !p.as_os_str().is_empty() && !dirs.contains(&p) { dirs.push(p); } };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Ok(out) = Command::new(&shell).args(["-lc", "printf %s \"$PATH\""]).stdin(Stdio::null()).stderr(Stdio::null()).output() {
        for d in String::from_utf8_lossy(&out.stdout).split(':') { push(PathBuf::from(d)); }
    }
    if let Ok(p) = std::env::var("PATH") { for d in p.split(':') { push(PathBuf::from(d)); } }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for d in [".local/bin", ".cargo/bin", ".npm-global/bin", ".bun/bin", "Library/pnpm", "bin", ".volta/bin"] { push(home.join(d)); }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] { push(PathBuf::from(d)); }
    dirs
}

fn resolve(path: &[PathBuf], bin: &str) -> Option<PathBuf> {
    path.iter().map(|d| d.join(bin)).find(|p| fs::metadata(p).map(|m| m.is_file()).unwrap_or(false))
}

fn path_env(path: &[PathBuf]) -> String { path.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>().join(":") }

#[tauri::command]
fn agents_detect(bridge: State<'_, Arc<Bridge>>) -> Vec<Agent> {
    if let Some(list) = bridge.detected.lock().unwrap().clone() { return list.into_iter().map(model_metadata).collect(); }
    let list: Vec<Agent> = AGENTS.iter().map(|(id, name, bin)| {
        let p = resolve(&bridge.path, bin);
        let version = p.as_ref().and_then(|p| Command::new(p).arg("--version").env("PATH", path_env(&bridge.path)).stdin(Stdio::null()).output().ok())
            .map(|o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string()).filter(|v| !v.is_empty());
        Agent { id: id.to_string(), name: name.to_string(), bin: bin.to_string(), installed: p.is_some(), path: p.map(|p| p.to_string_lossy().into_owned()), version, models:Vec::new(), model_source:String::new() }
    }).collect();
    *bridge.detected.lock().unwrap() = Some(list.clone());
    list.into_iter().map(model_metadata).collect()
}

// fixed argument templates per CLI -> (args, stdin, output file)
fn command(req: &RunReq, dir: &Path) -> Result<(Vec<String>, String, Option<PathBuf>), String> {
    let model = req.model.as_deref().filter(|m| !m.is_empty() && m.len() <= 64 && m.chars().all(|c| c.is_ascii_alphanumeric() || "._:-/".contains(c)));
    let schema = serde_json::to_string(&req.schema).map_err(|e| e.to_string())?;
    let schema_file = dir.join("schema.json");
    fs::write(&schema_file, &schema).map_err(|e| e.to_string())?;
    let sf = schema_file.to_string_lossy().into_owned();
    let full = format!("{}\n\n{}", req.system, req.prompt);
    // attached images: validated and written into the run directory
    if req.images.len() > 4 { return Err("at most 4 images".into()); }
    let mut images: Vec<(PathBuf, String, String)> = Vec::new(); // (file, mime, file name)
    for im in &req.images {
        let ext = match im.mime.as_str() { "image/png" => "png", "image/jpeg" => "jpg", "image/webp" => "webp", _ => return Err("invalid image type".into()) };
        if im.name.is_empty() || im.name.len() > 32 || !im.name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') { return Err("invalid image name".into()); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(&im.data).map_err(|_| "invalid image data".to_string())?;
        if bytes.is_empty() || bytes.len() > 6_000_000 { return Err("image too large (max 6 MB)".into()); }
        let file = dir.join(format!("{}.{}", im.name, ext));
        fs::write(&file, &bytes).map_err(|e| e.to_string())?;
        images.push((file, im.mime.clone(), format!("{}.{}", im.name, ext)));
    }
    let mut args: Vec<String>;
    let (mut stdin, mut output) = (String::new(), None);
    match req.provider.as_str() {
        "claude" => {
            args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--json-schema", &schema, "--tools", "", "--mcp-config", "{\"mcpServers\":{}}", "--strict-mcp-config", "--system-prompt", &req.system, "--no-session-persistence", "--effort", "low"].iter().map(|s| s.to_string()).collect();
            if let Some(m) = model { args.extend(["--model".into(), m.into()]); }
            let mut content = vec![serde_json::json!({"type": "text", "text": req.prompt})];
            for im in &req.images { content.push(serde_json::json!({"type": "image", "source": {"type": "base64", "media_type": im.mime, "data": im.data}})); }
            stdin = serde_json::json!({"type": "user", "message": {"role": "user", "content": content}}).to_string() + "\n";
        }
        "codex" => {
            let out = dir.join("out.json");
            args = ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--color", "never"].iter().map(|s| s.to_string()).collect();
            for (file, _, _) in &images { args.extend(["--image".into(), file.to_string_lossy().into_owned()]); }
            args.extend(["--output-schema".into(), sf.clone(), "-o".into(), out.to_string_lossy().into_owned()]);
            if let Some(m) = model { args.extend(["-m".into(), m.into()]); }
            args.push("-".into());
            stdin = full;
            output = Some(out);
        }
        "agy" => {
            // agy has many tools (shell, browser…); headless mode denies them and then returns NO output. The images are
            // files here: tell it to open them with view_file only (read-only) and answer directly.
            let prompt = if images.is_empty() { full } else {
                let names = images.iter().map(|(_, _, n)| n.clone()).collect::<Vec<_>>().join(", ");
                format!("{full}\n\nThe attached images are files in the current directory ({names}). Open them ONLY with view_file. Do not run commands or use any other tool. Then reply with the JSON.")
            };
            args = vec!["-p".into(), prompt, "--output-format".into(), "json".into(), "--json-schema".into(), sf, "--disable-slash-commands".into()];
            if let Some(m) = model { args.extend(["--model".into(), m.into()]); }
        }
        "gemini" => {
            let refs = images.iter().map(|(_, _, n)| format!("@{n}")).collect::<Vec<_>>().join(" ");
            args = vec!["-p".into(), format!("{full}\n\n{refs}\n\nReply ONLY with a JSON object matching this schema:\n{schema}"), "--output-format".into(), "json".into()];
            if let Some(m) = model { args.extend(["-m".into(), m.into()]); }
        }
        other => return Err(format!("unknown provider '{other}'")),
    }
    Ok((args, stdin, output))
}

#[tauri::command]
async fn agent_run(req: RunReq, bridge: State<'_, Arc<Bridge>>) -> Result<RunRes, String> {
    let b = bridge.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_blocking(req, b)).await.map_err(|e| e.to_string())?
}

fn run_blocking(req: RunReq, b: Arc<Bridge>) -> Result<RunRes, String> {
    let (_, name, bin) = AGENTS.iter().find(|(id, _, _)| *id == req.provider).ok_or_else(|| format!("unknown provider '{}'", req.provider))?;
    let exe = resolve(&b.path, bin).ok_or_else(|| format!("{name} no está instalado (no se encontró '{bin}')"))?;
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("aru-agent-{nanos}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (args, stdin, output) = command(&req, &dir)?;
    let run_id = req.run_id.clone().filter(|r| r.len() <= 64).unwrap_or_else(|| nanos.to_string());
    let t0 = Instant::now();
    let mut child = Command::new(&exe).args(&args).current_dir(&dir).env("PATH", path_env(&b.path)).env("NO_COLOR", "1")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("no se pudo iniciar {name}: {e}"))?;
    let pid = child.id();
    b.running.lock().unwrap().insert(run_id.clone(), pid);
    // stdin, stdout and stderr on their own threads (no pipe deadlock); a watchdog enforces the timeout
    let mut si = child.stdin.take().unwrap();
    std::thread::spawn(move || { let _ = si.write_all(stdin.as_bytes()); });
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let out_t = std::thread::spawn(move || { let mut s = String::new(); let _ = so.read_to_string(&mut s); s });
    let err_t = std::thread::spawn(move || { let mut s = String::new(); let _ = se.read_to_string(&mut s); s });
    let (bw, rw) = (b.clone(), run_id.clone());
    std::thread::spawn(move || {
        let start = Instant::now();
        while start.elapsed() < TIMEOUT { std::thread::sleep(Duration::from_millis(500)); if !bw.running.lock().unwrap().contains_key(&rw) { return; } }
        if let Some(pid) = bw.running.lock().unwrap().get(&rw) { let _ = Command::new("kill").arg(pid.to_string()).status(); }
    });
    let status = child.wait().map_err(|e| e.to_string())?;
    let stdout = out_t.join().unwrap_or_default();
    let mut stderr = err_t.join().unwrap_or_default();
    b.running.lock().unwrap().remove(&run_id);
    let cancelled = b.cancelled.lock().unwrap().remove(&run_id);
    let output = output.and_then(|p| fs::read_to_string(p).ok());
    let _ = fs::remove_dir_all(&dir);
    if stderr.len() > 4000 { stderr = stderr[stderr.len() - 4000..].to_string(); }
    let code = status.code().unwrap_or(if cancelled { 130 } else { -1 });
    Ok(RunRes { ok: status.success(), code, cancelled, stdout, stderr, output, ms: t0.elapsed().as_millis() as u64, run_id })
}

#[tauri::command]
fn agent_cancel(run_id: String, bridge: State<'_, Arc<Bridge>>) -> bool {
    let pid = bridge.running.lock().unwrap().get(&run_id).copied();
    if let Some(pid) = pid {
        bridge.cancelled.lock().unwrap().insert(run_id);
        return Command::new("kill").arg(pid.to_string()).status().map(|s| s.success()).unwrap_or(false);
    }
    false
}

// ---------------------------------------------------------------- workspace (projects = folders, documents = .aru files)
// Every path is relative to the workspace root and must be "Project" or "Project/Document.aru": no "..", no absolute
// paths, no hidden names. Deletes move into <root>/.papelera (recoverable).
struct Workspace { root: Mutex<PathBuf>, config: PathBuf }

#[derive(Serialize)]
struct DocInfo { name: String, modified: u64, size: u64 }
#[derive(Serialize)]
struct ProjectInfo { name: String, docs: Vec<DocInfo> }

fn valid_segment(s: &str) -> bool {
    !s.is_empty() && s.len() <= 120 && !s.starts_with('.') && s != ".." && !s.contains(['/', '\\', ':', '\0'])
}
fn ws_path(ws: &Workspace, rel: &str, want_doc: Option<bool>) -> Result<PathBuf, String> {
    let segs: Vec<&str> = rel.split('/').collect();
    let ok = match segs.len() { 1 => valid_segment(segs[0]), 2 => valid_segment(segs[0]) && valid_segment(segs[1]) && segs[1].ends_with(".aru") && segs[1].len() > 4, _ => false };
    if !ok { return Err(format!("ruta no válida: {rel}")); }
    if let Some(doc) = want_doc { if doc != (segs.len() == 2) { return Err(format!("ruta no válida: {rel}")); } }
    Ok(ws.root.lock().unwrap().join(rel))
}
fn mtime(p: &Path) -> u64 { fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0) }

#[tauri::command]
fn ws_root(ws: State<'_, Workspace>) -> Result<String, String> {
    let root = ws.root.lock().unwrap().clone();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().into_owned())
}
#[tauri::command]
fn ws_set_root(path: String, ws: State<'_, Workspace>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() { return Err("la carpeta debe ser una ruta absoluta".into()); }
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    if let Some(dir) = ws.config.parent() { let _ = fs::create_dir_all(dir); }
    fs::write(&ws.config, &path).map_err(|e| e.to_string())?;
    *ws.root.lock().unwrap() = p;
    Ok(path)
}
#[tauri::command]
fn ws_list(ws: State<'_, Workspace>) -> Result<Vec<ProjectInfo>, String> { list_ws(&ws) }
fn list_ws(ws: &Workspace) -> Result<Vec<ProjectInfo>, String> {
    let root = ws.root.lock().unwrap().clone();
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !e.path().is_dir() || !valid_segment(&name) { continue; }
        let mut docs = Vec::new();
        for f in fs::read_dir(e.path()).map_err(|e| e.to_string())?.flatten() {
            let fname = f.file_name().to_string_lossy().into_owned();
            if f.path().is_file() && fname.ends_with(".aru") && valid_segment(&fname) {
                docs.push(DocInfo { name: fname.trim_end_matches(".aru").to_string(), modified: mtime(&f.path()), size: f.metadata().map(|m| m.len()).unwrap_or(0) });
            }
        }
        out.push(ProjectInfo { name, docs });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}
#[tauri::command]
fn ws_read(rel: String, ws: State<'_, Workspace>) -> Result<String, String> { read_ws(&ws, &rel) }
fn read_ws(ws: &Workspace, rel: &str) -> Result<String, String> { fs::read_to_string(ws_path(ws, rel, Some(true))?).map_err(|e| e.to_string()) }
#[tauri::command]
fn ws_write(rel: String, contents: String, ws: State<'_, Workspace>) -> Result<(), String> { write_ws(&ws, &rel, &contents) }
fn write_ws(ws: &Workspace, rel: &str, contents: &str) -> Result<(), String> {
    let p = ws_path(ws, rel, Some(true))?;
    if let Some(dir) = p.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    // write to a temp file then rename: a crash never leaves a half-written document
    let tmp = p.with_extension("aru.tmp");
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}
#[tauri::command]
fn ws_mkdir(rel: String, ws: State<'_, Workspace>) -> Result<(), String> { fs::create_dir_all(ws_path(&ws, &rel, Some(false))?).map_err(|e| e.to_string()) }
#[tauri::command]
fn ws_rename(from: String, to: String, ws: State<'_, Workspace>) -> Result<(), String> { rename_ws(&ws, &from, &to) }
fn rename_ws(ws: &Workspace, from: &str, to: &str) -> Result<(), String> {
    let doc = from.contains('/');
    let (a, b) = (ws_path(ws, from, Some(doc))?, ws_path(ws, to, Some(doc))?);
    if b.exists() { return Err("ya existe un elemento con ese nombre".into()); }
    if let Some(dir) = b.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    fs::rename(a, b).map_err(|e| e.to_string())
}
#[tauri::command]
fn ws_trash(rel: String, ws: State<'_, Workspace>) -> Result<(), String> { trash_ws(&ws, &rel) }
fn trash_ws(ws: &Workspace, rel: &str) -> Result<(), String> {
    let p = ws_path(ws, rel, None)?;
    let trash = ws.root.lock().unwrap().join(".papelera");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let name = rel.replace('/', " - ");
    fs::rename(&p, trash.join(format!("{stamp} {name}"))).map_err(|e| e.to_string())
}

// text files picked by the user through the native dialogs
#[tauri::command]
fn read_text(path: String) -> Result<String, String> { fs::read_to_string(&path).map_err(|e| e.to_string()) }
#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> { fs::write(&path, contents).map_err(|e| e.to_string()) }

#[tauri::command]
fn write_zip(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"PK\x03\x04") || !bytes.windows(4).any(|w| w == b"PK\x05\x06") { return Err("ZIP inválido".into()); }
    fs::write(path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_png(path: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(&data).map_err(|_| "invalid PNG data".to_string())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("invalid PNG signature".to_string()); }
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bridge = Arc::new(Bridge { path: login_path(), running: Mutex::new(HashMap::new()), cancelled: Mutex::new(HashSet::new()), detected: Mutex::new(None) });
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(bridge)
        .setup(|app| {
            use tauri::Manager;
            let config = app.path().app_config_dir().map(|d| d.join("workspace.txt")).unwrap_or_else(|_| PathBuf::from("workspace.txt"));
            let default = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join("Documents").join("ARU Studio");
            let root = fs::read_to_string(&config).ok().map(|s| PathBuf::from(s.trim())).filter(|p| p.is_absolute()).unwrap_or(default);
            app.manage(Workspace { root: Mutex::new(root), config });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![agents_detect, agent_run, agent_cancel, read_text, write_text, write_png, write_zip, ws_root, ws_set_root, ws_list, ws_read, ws_write, ws_mkdir, ws_rename, ws_trash])
        .run(tauri::generate_context!())
        .expect("error while running ARU Studio");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_catalog_excludes_hidden_and_private_metadata() {
        let cache=serde_json::json!({"identity":"private","models":[{"slug":"visible","display_name":"Visible","visibility":"list"},{"slug":"hidden","visibility":"hide"},{"slug":"visible","visibility":"list"},{"slug":"bad model","visibility":"list"}]});
        let models=catalog_models(&cache);assert_eq!(models.len(),1);assert_eq!(models[0].id,"visible");assert_eq!(models[0].label,"Visible");
        assert!(catalog_models(&serde_json::json!({})).is_empty());
    }
    #[test]
    fn png_export_writes_binary_and_rejects_invalid_payloads() {
        let path = std::env::temp_dir().join(format!("aru-png-test-{}.png", std::process::id()));
        let bytes = include_bytes!("../icons/32x32.png");
        write_png(path.to_string_lossy().into_owned(), base64::engine::general_purpose::STANDARD.encode(bytes)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(write_png(path.to_string_lossy().into_owned(), "not base64!".into()).is_err());
        assert!(write_png(path.to_string_lossy().into_owned(), base64::engine::general_purpose::STANDARD.encode(b"not PNG")).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes, "invalid payload cannot overwrite a saved PNG");
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn zip_export_writes_bytes_and_rejects_invalid_payload_without_overwrite() {
        let path = std::env::temp_dir().join(format!("aru-zip-test-{}.zip", std::process::id()));
        let bytes = b"PK\x03\x04testPK\x05\x06";
        write_zip(path.to_string_lossy().into_owned(), base64::engine::general_purpose::STANDARD.encode(bytes)).unwrap();
        assert!(write_zip(path.to_string_lossy().into_owned(), "invalid base64".into()).is_err());
        assert!(write_zip(path.to_string_lossy().into_owned(), base64::engine::general_purpose::STANDARD.encode(b"not zip")).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::remove_file(path).unwrap();
    }
    fn req(provider: &str, model: &str) -> RunReq {
        RunReq { provider: provider.into(), model: Some(model.into()), system: "SYS".into(), prompt: "hola".into(), schema: serde_json::json!({"type": "object"}), run_id: None, images: vec![] }
    }
    #[test]
    fn templates_are_fixed_and_models_validated() {
        let dir = std::env::temp_dir().join("aru-test-cmd");
        fs::create_dir_all(&dir).unwrap();
        let (a, stdin, out) = command(&req("codex", "gpt-5.5"), &dir).unwrap();
        assert_eq!(a[0], "exec");
        assert!(a.contains(&"read-only".to_string()) && a.contains(&"gpt-5.5".to_string()));
        assert!(out.is_some() && stdin.contains("SYS") && stdin.contains("hola"));
        let (a, stdin, _) = command(&req("claude", "sonnet; rm -rf /"), &dir).unwrap();
        assert!(!a.iter().any(|x| x.contains("rm -rf")), "invalid model names are dropped");
        assert!(a.contains(&"--tools".to_string()) && stdin.contains("\"hola\""));
        assert!(command(&req("bash", ""), &dir).is_err(), "only the four known CLIs");
    }
    #[test]
    fn workspace_paths_are_confined() {
        let ws = Workspace { root: Mutex::new(PathBuf::from("/tmp/ws")), config: PathBuf::from("/tmp/ws.txt") };
        assert!(ws_path(&ws, "Logos/Sonus.aru", Some(true)).is_ok());
        assert!(ws_path(&ws, "Logos", Some(false)).is_ok());
        for bad in ["../x.aru", "Logos/../../etc.aru", "/etc/passwd", "Logos/x.txt", ".papelera/a.aru", "a/b/c.aru", "Logos/.aru", ""] {
            assert!(ws_path(&ws, bad, None).is_err(), "{bad} must be rejected");
        }
        assert!(ws_path(&ws, "Logos", Some(true)).is_err());
    }
    #[test]
    fn workspace_files_round_trip() {
        let root = std::env::temp_dir().join(format!("aru-ws-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let ws = Workspace { root: Mutex::new(root.clone()), config: root.join("cfg.txt") };
        write_ws(&ws, "Boxeo/Guantes.aru", "canvas 10 10").unwrap();
        write_ws(&ws, "Logos/Sonus.aru", "canvas 20 20").unwrap();
        let l = list_ws(&ws).unwrap();
        assert_eq!(l.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["Boxeo", "Logos"]);
        assert_eq!(read_ws(&ws, "Boxeo/Guantes.aru").unwrap(), "canvas 10 10");
        rename_ws(&ws, "Boxeo/Guantes.aru", "Logos/Guantes v2.aru").unwrap();
        assert!(rename_ws(&ws, "Logos/Sonus.aru", "Logos/Guantes v2.aru").is_err(), "never overwrite");
        trash_ws(&ws, "Logos/Sonus.aru").unwrap();
        let l = list_ws(&ws).unwrap();
        assert_eq!(l.iter().find(|p| p.name == "Logos").unwrap().docs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), vec!["Guantes v2"]);
        assert!(root.join(".papelera").read_dir().unwrap().count() == 1, "deleted document is recoverable");
        assert!(!l.iter().any(|p| p.name.starts_with('.')), "trash is hidden from the library");
        let _ = fs::remove_dir_all(&root);
    }
    #[test]
    fn finds_installed_clis_on_login_path() {
        let path = login_path();
        assert!(!path.is_empty());
        // at least the shell itself resolves through the same mechanism
        assert!(resolve(&path, "ls").is_some());
    }
}

#[cfg(test)]
mod live {
    use super::*;
    // cargo test -- --ignored   (calls the real Claude CLI once through the Rust bridge)
    #[test]
    #[ignore]
    fn claude_round_trip() {
        let b = Arc::new(Bridge { path: login_path(), running: Mutex::new(HashMap::new()), cancelled: Mutex::new(HashSet::new()), detected: Mutex::new(None) });
        let schema = serde_json::json!({"type":"object","additionalProperties":false,"required":["reply","ok"],"properties":{"reply":{"type":"string"},"ok":{"type":"boolean"}}});
        let r = run_blocking(RunReq { provider: "claude".into(), model: Some("haiku".into()), system: "Answer with reply='hola' and ok=true.".into(), prompt: "ping".into(), schema, run_id: Some("t1".into()), images: vec![] }, b).unwrap();
        assert!(r.ok, "stderr: {}", r.stderr);
        let v: serde_json::Value = r.stdout.lines().rev().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).find(|e| e["type"] == "result").unwrap();
        assert_eq!(v["structured_output"]["ok"], serde_json::json!(true));
        println!("claude via Rust bridge: {} ms, {}", r.ms, v["structured_output"]);
    }
}
