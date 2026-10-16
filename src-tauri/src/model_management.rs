use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use serde_json::{json, Value};

const STATE_FILE: &str = "gui-models.json";

fn read(path: &Path) -> Result<Value, String> { super::read_config(path) }
fn identifier(provider: &str, id: &str) -> Result<(), String> {
    if provider.trim().is_empty() || id.trim().is_empty() || provider.contains(['/', '\\', '\0']) || id.contains('\0') {
        return Err("Invalid model identifier.".into());
    }
    Ok(())
}
fn removed(state: &Value, provider: &str, id: &str) -> bool {
    state.get("removed").and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| item["provider"] == provider && item["id"] == id))
}
fn mark_removed(state: &mut Value, provider: &str, id: &str) -> Result<(), String> {
    if removed(state, provider, id) { return Ok(()); }
    let items = state.as_object_mut().ok_or("Model state must be an object")?
        .entry("removed").or_insert_with(|| json!([])).as_array_mut().ok_or("Model removal state must be an array")?;
    items.push(json!({"provider":provider,"id":id}));
    Ok(())
}
fn unmark(state: &mut Value, provider: &str, id: &str) {
    if let Some(items) = state.get_mut("removed").and_then(Value::as_array_mut) {
        items.retain(|item| !(item["provider"] == provider && item["id"] == id));
    }
}
fn state_at(dir: &Path) -> Result<Value, String> {
    let value = read(&dir.join(STATE_FILE))?;
    if value.get("removed").is_some_and(|v| !v.is_array()) { return Err("Invalid gui-models.json: removed must be an array; file was not changed.".into()); }
    if let Some(items) = value.get("removed").and_then(Value::as_array) {
        for item in items {
            let provider = item["provider"].as_str().ok_or("Invalid removed provider")?;
            let id = item["id"].as_str().ok_or("Invalid removed model ID")?;
            identifier(provider, id)?;
            for field in ["custom", "catalog"] {
                if let Some(saved) = item.get(field) {
                    if !saved.is_object() || saved["id"].as_str() != Some(id) { return Err("Invalid saved removed-model definition.".into()); }
                }
            }
        }
    }
    Ok(value)
}

type Snapshot = BTreeMap<PathBuf, Option<Vec<u8>>>;
fn bytes_at(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}
fn snapshot(dir: &Path) -> Result<Snapshot, String> {
    ["models.json", "models-store.json", "settings.json", STATE_FILE].iter().map(|name| {
        let path = dir.join(name); Ok((path.clone(), bytes_at(&path)?))
    }).collect()
}

/// Refuse stale writes; if a later file fails, roll back only our own earlier writes.
fn commit(changes: Vec<(PathBuf, Value)>, expected: &Snapshot) -> Result<(), String> {
    for (path, bytes) in expected {
        if bytes_at(path)? != *bytes { return Err("Model configuration changed externally. Refresh and retry.".into()); }
    }
    let mut writes = Vec::new();
    for (path, value) in changes {
        let original = bytes_at(&path)?;
        let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
        if original.as_ref() == Some(&bytes) { continue; }
        writes.push((path, bytes, original));
    }
    for (index, (path, bytes, original)) in writes.iter().enumerate() {
        let result = match bytes_at(path) {
            Ok(current) if current == *original => super::atomic_write(path, bytes),
            Ok(_) => Err("Model configuration changed externally. Refresh and retry.".into()),
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            let mut recovery = Vec::new();
            for (old_path, written, original) in writes[..index].iter().rev() {
                if bytes_at(old_path).ok().flatten().as_ref() != Some(written) { recovery.push(format!("{} changed externally; not overwritten", old_path.display())); continue; }
                let result = match original {
                    Some(bytes) => super::atomic_write(old_path, bytes),
                    None => std::fs::remove_file(old_path).map_err(|e| e.to_string()),
                };
                if let Err(e) = result { recovery.push(format!("{}: {e}", old_path.display())); }
            }
            return Err(if recovery.is_empty() { format!("Model update failed and was rolled back: {error}") } else { format!("Model update failed: {error}. Recovery errors: {}", recovery.join("; ")) });
        }
    }
    Ok(())
}

fn merged(dir: &Path) -> Result<(BTreeMap<(String, String), Value>, Value, Value, Value), String> {
    let catalog = read(&dir.join("models-store.json"))?;
    let custom = read(&dir.join("models.json"))?;
    let state = state_at(dir)?;
    let mut result = BTreeMap::new();
    let auth = read(&dir.join("auth.json"))?;
    let auth_keys = auth.as_object().ok_or("Auth file must contain an object")?;
    for (provider, source) in catalog.as_object().ok_or("Model catalog must contain an object")? {
        if !auth_keys.is_empty() && !auth_keys.contains_key(provider) { continue; }
        if let Some(models) = source.get("models").and_then(Value::as_array) {
            for model in models {
                if let Some(id) = model.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    result.insert((provider.clone(), id.to_owned()), row(provider, model, "catalog"));
                }
            }
        }
    }
    if let Some(providers) = custom.get("providers") {
        for (provider, source) in providers.as_object().ok_or("models.json providers must be an object")? {
            if let Some(models) = source.get("models") {
                for model in models.as_array().ok_or("Provider models must be an array")? {
                    if let Some(id) = model.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        result.insert((provider.clone(), id.to_owned()), row(provider, model, "custom"));
                    }
                }
            }
            if let Some(overrides) = source.get("modelOverrides").and_then(Value::as_object) {
                for (id, overlay) in overrides {
                    if let Some(item) = result.get_mut(&(provider.clone(), id.clone())) {
                        if let Some(name) = overlay.get("name").and_then(Value::as_str) { item["name"] = json!(name); }
                    }
                }
            }
        }
    }
    Ok((result, catalog, custom, state))
}
fn row(provider: &str, model: &Value, source: &str) -> Value {
    let id = model["id"].as_str().unwrap_or_default();
    json!({"provider":provider,"id":id,"name":model["name"].as_str().unwrap_or(id),"value":format!("{provider}/{id}"),"deletable":true,"editable":true,"source":source})
}

pub(crate) fn list(dir: &Path) -> Result<Value, String> {
    let (models, _, _, state) = merged(dir)?;
    let settings = read(&dir.join("settings.json"))?;
    let provider = settings["defaultProvider"].as_str().unwrap_or_default();
    let id = settings["defaultModel"].as_str().unwrap_or_default();
    let current = if provider.is_empty() || id.is_empty() { String::new() } else { format!("{provider}/{id}") };
    let items: Vec<_> = models.into_iter().filter(|((p, id), _)| !removed(&state, p, id)).map(|(_, value)| value).collect();
    Ok(json!({"models":items,"current":current,"removedCount":state.get("removed").and_then(Value::as_array).map_or(0, Vec::len)}))
}

fn remove_from(root: &mut Value, provider: &str, id: &str, custom: bool) -> Result<bool, String> {
    let entries = if custom { root.get_mut("providers") } else { Some(root) };
    let Some(entries) = entries else { return Ok(false); };
    let Some(entry) = entries.as_object_mut().ok_or("Invalid model provider object")?.get_mut(provider) else { return Ok(false); };
    let object = entry.as_object_mut().ok_or("Invalid provider configuration")?;
    let mut found = false;
    if let Some(models) = object.get_mut("models") {
        let models = models.as_array_mut().ok_or("Invalid models array")?;
        let before = models.len();
        models.retain(|model| model["id"].as_str() != Some(id));
        found = before != models.len();
    }
    if custom {
        if let Some(overrides) = object.get_mut("modelOverrides") {
            let overrides = overrides.as_object_mut().ok_or("Invalid modelOverrides object")?;
            found |= overrides.remove(id).is_some();
        }
    }
    Ok(found)
}

pub(crate) fn remove(dir: &Path, provider: &str, id: &str) -> Result<(), String> {
    remove_many(dir, &[(provider.to_owned(), id.to_owned())]).map(|_| ())
}

/// Batch deletion shares one snapshot and commit: a missing target cannot cause a half-cleared list.
pub(crate) fn remove_many(dir: &Path, targets: &[(String, String)]) -> Result<usize, String> {
    if targets.is_empty() { return Err("Select at least one model.".into()); }
    if targets.len() > 10000 { return Err("Too many models in one operation.".into()); }
    let mut unique = std::collections::BTreeSet::new();
    for (provider, id) in targets { identifier(provider, id)?; unique.insert((provider.as_str(), id.as_str())); }
    let expected = snapshot(dir)?;
    let mut custom = read(&dir.join("models.json"))?;
    let mut catalog = read(&dir.join("models-store.json"))?;
    let mut state = state_at(dir)?;
    let mut settings = read(&dir.join("settings.json"))?;
    let mut custom_changed = false;
    let mut catalog_changed = false;
    let mut settings_changed = false;
    let mut count = 0;
    for (provider, id) in unique {
        if removed(&state, provider, id) { continue; }
        let saved_custom = find_model(&custom, provider, id, true).cloned();
        let saved_catalog = find_model(&catalog, provider, id, false).cloned();
        let saved_override = custom.get("providers").and_then(|p| p.get(provider)).and_then(|p| p.get("modelOverrides")).and_then(|p| p.get(id)).cloned();
        let in_custom = remove_from(&mut custom, provider, id, true)?;
        let in_catalog = remove_from(&mut catalog, provider, id, false)?;
        if !in_custom && !in_catalog { return Err(format!("Model {provider}/{id} was not found. Refresh and retry; nothing was deleted.")); }
        mark_removed(&mut state, provider, id)?;
        let record = state["removed"].as_array_mut().unwrap().iter_mut()
            .find(|item| item["provider"] == provider && item["id"] == id).unwrap();
        if let Some(model) = saved_custom { record["custom"] = model; }
        if let Some(model) = saved_catalog { record["catalog"] = model; }
        if let Some(overlay) = saved_override { record["override"] = overlay; }
        custom_changed |= in_custom; catalog_changed |= in_catalog; count += 1;
        if settings["defaultProvider"].as_str() == Some(provider) && settings["defaultModel"].as_str() == Some(id) {
            let object = settings.as_object_mut().unwrap();
            object.remove("defaultProvider"); object.remove("defaultModel"); settings_changed = true;
        }
    }
    if count == 0 { return Ok(0); }
    let mut changes = vec![(dir.join(STATE_FILE), state)];
    if custom_changed { changes.push((dir.join("models.json"), custom)); }
    if catalog_changed { changes.push((dir.join("models-store.json"), catalog)); }
    if settings_changed { changes.push((dir.join("settings.json"), settings)); }
    commit(changes, &expected)?;
    Ok(count)
}

pub(crate) fn restore(dir: &Path) -> Result<(), String> {
    let expected = snapshot(dir)?;
    let mut state = state_at(dir)?;
    let mut custom = read(&dir.join("models.json"))?;
    let mut catalog = read(&dir.join("models-store.json"))?;
    let items = state.get("removed").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut custom_changed = false;
    let mut catalog_changed = false;
    for item in items {
        let provider = item["provider"].as_str().ok_or("Invalid removed provider")?;
        let id = item["id"].as_str().ok_or("Invalid removed model ID")?;
        identifier(provider, id)?;
        for (field, root, is_custom) in [("custom", &mut custom, true), ("catalog", &mut catalog, false)] {
            if let Some(model) = item.get(field) {
                let providers = if is_custom { root.as_object_mut().unwrap().entry("providers").or_insert_with(|| json!({})) } else { root };
                let entry = providers.as_object_mut().ok_or("Invalid provider container")?.entry(provider).or_insert_with(|| json!({}));
                let models = entry.as_object_mut().ok_or("Invalid provider object")?.entry("models").or_insert_with(|| json!([])).as_array_mut().ok_or("Invalid models array")?;
                if !models.iter().any(|model| model["id"].as_str() == Some(id)) { models.push(model.clone()); }
                if is_custom { custom_changed = true; } else { catalog_changed = true; }
            }
        }
        if let Some(overlay) = item.get("override") {
            let providers = custom.as_object_mut().unwrap().entry("providers").or_insert_with(|| json!({})).as_object_mut().ok_or("Invalid providers")?;
            let provider = providers.entry(provider).or_insert_with(|| json!({})).as_object_mut().ok_or("Invalid provider")?;
            provider.entry("modelOverrides").or_insert_with(|| json!({})).as_object_mut().ok_or("Invalid model overrides")?.entry(id).or_insert_with(|| overlay.clone());
            custom_changed = true;
        }
    }
    state["removed"] = json!([]);
    let mut changes = Vec::new();
    if custom_changed { changes.push((dir.join("models.json"), custom)); }
    if catalog_changed { changes.push((dir.join("models-store.json"), catalog)); }
    changes.push((dir.join(STATE_FILE), state));
    commit(changes, &expected)
}

pub(crate) fn unhide(dir: &Path, provider: &str, ids: &[String]) -> Result<(), String> {
    if !dir.join(STATE_FILE).exists() { return Ok(()); }
    let expected = snapshot(dir)?;
    let mut state = state_at(dir)?;
    for id in ids { unmark(&mut state, provider, id); }
    commit(vec![(dir.join(STATE_FILE), state)], &expected)
}

fn find_model<'a>(root: &'a Value, provider: &str, id: &str, custom: bool) -> Option<&'a Value> {
    let source = if custom { root.get("providers")? } else { root };
    source.get(provider)?.get("models")?.as_array()?.iter().find(|model| model["id"].as_str() == Some(id))
}

pub(crate) fn edit_info(dir: &Path, provider: &str, id: &str) -> Result<Value, String> {
    identifier(provider, id)?;
    let custom = read(&dir.join("models.json"))?;
    let catalog = read(&dir.join("models-store.json"))?;
    let model = find_model(&custom, provider, id, true).or_else(|| find_model(&catalog, provider, id, false)).ok_or("Model was not found.")?;
    let config = &custom["providers"][provider];
    let source = &catalog[provider];
    let api = model["api"].as_str().or(config["api"].as_str()).or(source["api"].as_str()).unwrap_or("openai-completions");
    let baseurl = model["baseUrl"].as_str().or(config["baseUrl"].as_str()).or(source["baseUrl"].as_str()).unwrap_or_default();
    // Never send stored credentials back to the webview. Blank means preserve.
    Ok(json!({"provider":provider,"id":id,"name":model["name"].as_str().unwrap_or(id),"api":api,"baseurl":baseurl,"hasKey":config.get("apiKey").is_some()}))
}

pub(crate) fn edit(dir: &Path, provider: &str, original: &str, id: &str, name: &str, api: &str, baseurl: &str, apikey: &str) -> Result<(), String> {
    identifier(provider, original)?; identifier(provider, id)?;
    let expected = snapshot(dir)?;
    if name.trim().is_empty() || name.len() > 960 || id.len() > 1600 { return Err("Model name or ID is invalid.".into()); }
    if !baseurl.is_empty() && !(baseurl.starts_with("http://") || baseurl.starts_with("https://")) { return Err("Base URL must use HTTP or HTTPS.".into()); }
    let mut custom = read(&dir.join("models.json"))?;
    let mut catalog = read(&dir.join("models-store.json"))?;
    let mut state = state_at(dir)?;
    let template = find_model(&custom, provider, original, true).or_else(|| find_model(&catalog, provider, original, false)).cloned().ok_or("Model was not found.")?;
    if id != original && (find_model(&custom, provider, id, true).is_some() || find_model(&catalog, provider, id, false).is_some()) { return Err("That model ID already exists for this provider.".into()); }
    let providers = custom.as_object_mut().ok_or("Invalid models.json")?.entry("providers").or_insert_with(|| json!({})).as_object_mut().ok_or("Invalid providers object")?;
    let entry = providers.entry(provider).or_insert_with(|| json!({})).as_object_mut().ok_or("Invalid provider configuration")?;
    if !apikey.is_empty() { entry.insert("apiKey".into(), json!(apikey)); }
    let mut definition = template;
    let definition = definition.as_object_mut().ok_or("Invalid model entry")?;
    const ALLOWED: &[&str] = &["id","name","api","baseUrl","reasoning","thinkingLevelMap","input","inputLimits","cost","promptCache","contextWindow","maxTokens","samplingParams","samplingParamsByThinkingLevel","headers","compat"];
    definition.retain(|key, _| ALLOWED.contains(&key.as_str()));
    definition.insert("id".into(), json!(id)); definition.insert("name".into(), json!(name.trim()));
    if !api.is_empty() { definition.insert("api".into(), json!(api)); }
    if !baseurl.is_empty() { definition.insert("baseUrl".into(), json!(baseurl)); }
    else { definition.remove("baseUrl"); }
    let definition = Value::Object(definition.clone());
    let models = entry.entry("models").or_insert_with(|| json!([])).as_array_mut().ok_or("Invalid models array")?;
    if let Some(index) = models.iter().position(|m| m["id"].as_str() == Some(original)) { models[index] = definition; } else { models.push(definition); }
    let mut changes = Vec::new();
    if id != original {
        if let Some(overrides) = custom.get_mut("providers").and_then(|p| p.get_mut(provider)).and_then(|p| p.get_mut("modelOverrides")).and_then(Value::as_object_mut) {
            if let Some(overlay) = overrides.remove(original) { overrides.insert(id.to_owned(), overlay); }
        }
        if remove_from(&mut catalog, provider, original, false)? { changes.push((dir.join("models-store.json"), catalog)); }
        mark_removed(&mut state, provider, original)?;
        let mut settings = read(&dir.join("settings.json"))?;
        if settings["defaultProvider"].as_str() == Some(provider) && settings["defaultModel"].as_str() == Some(original) {
            settings["defaultModel"] = json!(id); changes.push((dir.join("settings.json"), settings));
        }
    }
    if let Some(overlay) = custom.get_mut("providers").and_then(|p| p.get_mut(provider)).and_then(|p| p.get_mut("modelOverrides")).and_then(|p| p.get_mut(id)).and_then(Value::as_object_mut) { overlay.insert("name".into(), json!(name.trim())); }
    unmark(&mut state, provider, id);
    changes.push((dir.join("models.json"), custom));
    changes.push((dir.join(STATE_FILE), state));
    commit(changes, &expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let dir = crate::tests::scratch();
        super::super::atomic_write(&dir.join("models-store.json"), br#"{"deepseek":{"etag":"unchanged","models":[{"id":"legacy","name":"Old model","api":"openai-completions","contextWindow":65536,"maxTokens":8192},{"id":"stay","name":"Keep"}]}}"#).unwrap();
        super::super::atomic_write(&dir.join("models.json"), br#"{"providers":{"relay":{"apiKey":"private-key","models":[{"id":"new-model","name":"New model"}]}}}"#).unwrap();
        dir
    }
    #[test]
    fn legacy_and_custom_models_both_have_edit_and_delete_actions() {
        let dir = fixture();
        let value = list(&dir).unwrap();
        let models = value["models"].as_array().unwrap();
        assert_eq!(models.len(), 3);
        assert!(models.iter().all(|m| m["deletable"] == true && m["editable"] == true));
        remove(&dir, "deepseek", "legacy").unwrap();
        let stored = read(&dir.join("models-store.json")).unwrap();
        assert_eq!(stored["deepseek"]["models"].as_array().unwrap().len(), 1);
        assert_eq!(stored["deepseek"]["models"][0]["id"], "stay");
        assert_eq!(stored["deepseek"]["etag"], "unchanged");
        // Simulate Pi catalog refresh or a restart that re-fetches the deleted item.
        super::super::atomic_write(&dir.join("models-store.json"), br#"{"deepseek":{"models":[{"id":"legacy"},{"id":"stay"}]}}"#).unwrap();
        let refreshed = list(&dir).unwrap();
        assert!(!refreshed["models"].as_array().unwrap().iter().any(|m| m["id"] == "legacy"));
        assert_eq!(refreshed["removedCount"], 1);
        assert_eq!(read(&dir.join("models.json")).unwrap()["providers"]["relay"]["apiKey"], "private-key");
        restore(&dir).unwrap();
        assert_eq!(list(&dir).unwrap()["models"].as_array().unwrap().len(), 3);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn catalog_delete_without_custom_file_can_restore_the_original_entry() {
        let dir = fixture();
        std::fs::remove_file(dir.join("models.json")).unwrap();
        remove(&dir, "deepseek", "legacy").unwrap();
        assert!(!dir.join("models.json").exists());
        restore(&dir).unwrap();
        let value = list(&dir).unwrap();
        assert!(value["models"].as_array().unwrap().iter().any(|m| m["id"] == "legacy" && m["name"] == "Old model"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn legacy_edit_creates_valid_override_and_keeps_other_models_and_keys() {
        let dir = fixture();
        let info = edit_info(&dir, "relay", "new-model").unwrap();
        assert!(info.get("apiKey").is_none());
        assert!(!info.to_string().contains("private-key"));
        edit(&dir, "deepseek", "legacy", "legacy", "Renamed", "openai-completions", "https://example.test/v1", "").unwrap();
        let custom = read(&dir.join("models.json")).unwrap();
        assert_eq!(custom["providers"]["deepseek"]["models"][0]["name"], "Renamed");
        assert_eq!(custom["providers"]["deepseek"]["models"][0]["contextWindow"], 65536);
        assert_eq!(custom["providers"]["relay"]["apiKey"], "private-key");
        assert_eq!(list(&dir).unwrap()["models"].as_array().unwrap().iter().filter(|m| m["value"] == "deepseek/legacy").count(), 1);
        edit(&dir, "relay", "new-model", "renamed-id", "Label", "openai-completions", "", "").unwrap();
        assert_eq!(read(&dir.join("models.json")).unwrap()["providers"]["relay"]["apiKey"], "private-key");
        let bytes = std::fs::read(dir.join("models.json")).unwrap();
        assert!(edit(&dir, "relay", "renamed-id", "renamed-id", "Label", "openai-completions", "file:///private", "").is_err());
        assert_eq!(std::fs::read(dir.join("models.json")).unwrap(), bytes);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn corrupt_inputs_and_failed_commit_do_not_report_success_or_erase_data() {
        let dir = fixture();
        let catalog = std::fs::read(dir.join("models-store.json")).unwrap();
        super::super::atomic_write(&dir.join("settings.json"), b"not-json").unwrap();
        assert!(remove(&dir, "deepseek", "legacy").is_err());
        assert_eq!(std::fs::read(dir.join("models-store.json")).unwrap(), catalog);
        std::fs::remove_file(dir.join("settings.json")).unwrap();
        assert!(commit(vec![(dir.join("temporary-state.json"), json!({"x":true})), (dir.join("models-store.json").join("impossible.json"), json!({}))], &snapshot(&dir).unwrap()).is_err());
        assert!(!dir.join("temporary-state.json").exists());
        assert_eq!(std::fs::read(dir.join("models-store.json")).unwrap(), catalog);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn readding_a_removed_id_makes_it_visible_again() {
        let dir = fixture();
        remove(&dir, "relay", "new-model").unwrap();
        let mut root = read(&dir.join("models.json")).unwrap();
        root["providers"]["relay"]["models"] = json!([{"id":"new-model","name":"New again"}]);
        super::super::atomic_write(&dir.join("models.json"), &serde_json::to_vec_pretty(&root).unwrap()).unwrap();
        unhide(&dir, "relay", &["new-model".to_owned()]).unwrap();
        assert!(list(&dir).unwrap()["models"].as_array().unwrap().iter().any(|m| m["name"] == "New again"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod revision_tests {
    use super::*;
    #[test]
    fn changed_catalog_cannot_be_overwritten_by_a_stale_edit() {
        let dir = crate::tests::scratch();
        let path = dir.join("models-store.json");
        super::super::atomic_write(&path, b"{}").unwrap();
        let expected = snapshot(&dir).unwrap();
        super::super::atomic_write(&path, br#"{"refreshed":true}"#).unwrap();
        assert!(commit(vec![(path.clone(), json!({"stale":true}))], &expected).is_err());
        assert_eq!(read(&path).unwrap()["refreshed"], true);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod rollback_tests {
    use super::*;
    #[test]
    fn later_commit_failure_rolls_back_earlier_file_bytes() {
        let dir = crate::tests::scratch(); let path = dir.join("models.json");
        let original = br#"{"unchanged":true}"#;
        super::super::atomic_write(&path, original).unwrap();
        let expected = snapshot(&dir).unwrap();
        // Reusing the same destination causes the second optimistic check to fail.
        assert!(commit(vec![(path.clone(), json!({"first":true})), (path.clone(), json!({"second":true}))], &expected).is_err());
        assert_eq!(std::fs::read(path).unwrap(), original);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod bulk_tests {
    use super::*;
    fn fixture() -> PathBuf {
        let dir=crate::tests::scratch();
        super::super::atomic_write(&dir.join("models-store.json"), br#"{"legacy":{"etag":"keep","models":[{"id":"old/one"},{"id":"old/two"}]}}"#).unwrap();
        super::super::atomic_write(&dir.join("models.json"), br#"{"providers":{"custom":{"apiKey":"keep-key","baseUrl":"https://example.test","models":[{"id":"new"}]}}}"#).unwrap();
        super::super::atomic_write(&dir.join("settings.json"), br#"{"defaultProvider":"legacy","defaultModel":"old/one","unrelated":true}"#).unwrap();
        dir
    }
    #[test]
    fn bulk_delete_spans_both_sources_without_touching_other_models_or_secrets() {
        let dir=fixture();
        let count=remove_many(&dir,&[("legacy".into(),"old/one".into()),("custom".into(),"new".into()),("custom".into(),"new".into())]).unwrap();
        assert_eq!(count,2);
        let value=list(&dir).unwrap();assert_eq!(value["models"].as_array().unwrap().len(),1);
        assert_eq!(value["models"][0]["id"],"old/two");
        assert_eq!(value["removedCount"],2);
        let config=read(&dir.join("models.json")).unwrap();assert_eq!(config["providers"]["custom"]["apiKey"],"keep-key");
        assert_eq!(config["providers"]["custom"]["baseUrl"],"https://example.test");
        let settings=read(&dir.join("settings.json")).unwrap();assert!(settings.get("defaultModel").is_none());assert_eq!(settings["unrelated"],true);
        restore(&dir).unwrap();assert_eq!(list(&dir).unwrap()["models"].as_array().unwrap().len(),3);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_or_invalid_target_prevents_any_partial_batch_write() {
        let dir=fixture();let before=snapshot(&dir).unwrap();
        assert!(remove_many(&dir,&[("legacy".into(),"old/one".into()),("z".into(),"missing".into())]).is_err());
        assert_eq!(snapshot(&dir).unwrap(),before);
        assert!(remove_many(&dir,&[("legacy".into(),"old/one".into()),("".into(),"invalid".into())]).is_err());
        assert_eq!(snapshot(&dir).unwrap(),before);assert!(remove_many(&dir,&[]).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn clear_all_can_restore_legacy_custom_and_provider_configuration() {
        let dir=fixture();let value=list(&dir).unwrap();
        let targets:Vec<_>=value["models"].as_array().unwrap().iter().map(|m|(m["provider"].as_str().unwrap().into(),m["id"].as_str().unwrap().into())).collect();
        assert_eq!(remove_many(&dir,&targets).unwrap(),3);
        assert!(list(&dir).unwrap()["models"].as_array().unwrap().is_empty());
        assert_eq!(remove_many(&dir,&targets).unwrap(),0);
        restore(&dir).unwrap();assert_eq!(list(&dir).unwrap()["models"].as_array().unwrap().len(),3);
        assert_eq!(read(&dir.join("models-store.json")).unwrap()["legacy"]["etag"],"keep");
        assert_eq!(read(&dir.join("models.json")).unwrap()["providers"]["custom"]["apiKey"],"keep-key");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
