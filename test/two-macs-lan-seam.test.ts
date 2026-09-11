import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Ignore line comments so a description of an excluded feature cannot satisfy
// a presence guard or falsely look like an actual local-reader call.
const swift = (file: string) => source(`mac-app/conch-mac/${file}`).replace(/^\s*\/\/.*$/gm, "");
function before(text: string, first: string, second: string) {
  const a = text.indexOf(first), b = text.indexOf(second);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(b);
}
function section(text: string, start: string, end: string) {
  before(text, start, end);
  return text.slice(text.indexOf(start), text.indexOf(end));
}

test("A1 Swift remote documents stay per owner and callbacks check identity before publication", () => {
  const store = swift("RemoteMacStore.swift");
  expect(store).toContain("var documents: [String: PublishedState] = [:]");
  expect(store).toContain("let ownerDeviceId: String");
  expect(store).toContain("let localSessionKey: String");
  expect(store).toContain("var drafts: [RemoteSessionID: String] = [:]");
  expect(store).toContain("documents[target.ownerDeviceId]?.rows.first { $0.id == target.localSessionKey }");
  const callback = section(store, "transport.onStateData =", "transport.onConnectionChange =");
  before(callback, "transports[ownerDeviceId] === transport", "JSONDecoder().decode(PublishedState.self");
  before(callback, "guard document.ownerDeviceId == ownerDeviceId", "documents[ownerDeviceId] = document");
  expect(callback).toContain("transport.stop()");
  expect(store).not.toMatch(/\bStateStore\b|\bConchSocketClient\b|forgetGone|\.rows\s*\+=|\.rows\.append|\.rows\.append\(contentsOf:/);
  expect(swift("StateStore.swift")).not.toMatch(/\bRemoteMacStore\b|\bRemoteSessionID\b/);
  expect(store).toContain("documents.removeValue(forKey: pairing.ownerDeviceId)");
  expect(store).toContain("drafts = drafts.filter { $0.key.ownerDeviceId != pairing.ownerDeviceId }");
});

test("A1 Swift remote groups tag owners and isolate text-only UI from local paths and controls", () => {
  const views = swift("RemoteMacViews.swift");
  const groups = section(views, "struct RemoteMacGroups:", "struct RemoteSessionView:");
  expect(groups).toContain("Text");
  expect(groups).toContain("Label(pairing.endpoint.title");
  expect(groups).toContain("remotes.documents[pairing.ownerDeviceId]?.rows");
  expect(groups).toContain("RemoteSessionID(ownerDeviceId: pairing.ownerDeviceId, localSessionKey: row.id)");
  expect(groups).toContain('Text("Owner: \\(target.ownerDeviceId.prefix(8))")');
  const session = views.slice(views.indexOf("struct RemoteSessionView:"));
  expect(session).toContain("remotes.conversation(for: target)");
  expect(session).toContain("remotes.reply(for: target)");
  expect(session).toContain("remotes.download(path, for: target)");
  expect(session).toContain("remotes.send(text, to: target)");
  expect(session).toContain("TextField(");
  // The one StateStore use allowed here is its link door (A13): a remote
  // review's web link is a page this Mac opens itself. Remote rows still
  // never reach the local store's ledger or transcript machinery.
  expect(session).toContain("@EnvironmentObject private var store: StateStore");
  expect(session.match(/\bstore\.\w+/g)).toEqual(["store.openLink"]);
  expect(session.replace("@EnvironmentObject private var store: StateStore", "")).not.toMatch(/\bComposerView\b|\bTranscriptContentModel\b|\bArtifactPreview\b|\bStateStore\b|NSOpenPanel|fileImporter|revealSession|\bmic\b|\battachments\b|\bConchSocketClient\b|URL\(fileURLWithPath:/);
  expect(session).toContain("if url.isFileURL || url.scheme == nil");
  const content = swift("ContentView.swift");
  expect(content).toContain("onSelectRemote: { remoteSelection = $0 }");
  expect(content).toContain(".sheet(item: $remoteSelection)");
  expect(content).toContain("remoteSelection == nil && !isShowingKeyboardShortcuts");
  expect(swift("DashboardView.swift").match(/RemoteMacGroups\(onSelect: onSelectRemote\)/g)).toHaveLength(2);
});

test("A1 Swift typed send is owner-enveloped, handles refusals and says accepted", () => {
  const send = section(swift("RemoteMacStore.swift"), "    func send(", "    func download(");
  expect(send).toContain('"type": "inject", "sessionId": target.localSessionKey');
  expect(send).toContain('"kind": "control-envelope", "ownerDeviceId": target.ownerDeviceId, "body": body');
  before(send, "let envelope:", 'path: "/control"');
  expect(send).toContain("JSONSerialization.data(withJSONObject: envelope)");
  expect(send).toContain('refusal.kind == "routing-error" || refusal.kind == "session-error"');
  before(send, "try response.requireSuccess()", 'return "Accepted by');
  before(send, "try requireCurrent(transport, target: target)", 'return "Accepted by');
  before(send, 'if !reply.isEmpty', 'return "Accepted by');
  expect(send).not.toMatch(/delivered/i);
});

test("A1 Swift pairing stores many Macs with one Keychain account per owner", () => {
  const source = swift("RemoteMacStore.swift");
  const keychain = section(source, "enum RemoteMacPairingStore", "@MainActor");
  expect(keychain).toContain('service = "ai.blueprintstudio.conch.remote-macs"');
  expect(keychain).toContain("kSecAttrAccount as String: ownerDeviceId");
  expect(keychain).toContain("kSecMatchLimit as String: kSecMatchLimitAll");
  expect(keychain).toContain("JSONDecoder().decode(RemoteMacPairing.self");
  const listQuery = section(keychain, "let query: [String: Any] =", "var result: CFTypeRef?");
  expect(listQuery).not.toContain("kSecReturnData");
  expect(keychain).toContain("var credentialQuery = self.query(ownerDeviceId: account)");
  expect(keychain).toContain("credentialQuery[kSecReturnData as String] = true");
  expect(keychain).toContain("SecItemCopyMatching(credentialQuery as CFDictionary, &credential)");
  expect(keychain).toContain("query(ownerDeviceId: pairing.ownerDeviceId)");
  expect(keychain).toContain("SecItemUpdate(key as CFDictionary");
  expect(keychain).toContain("SecItemDelete(query(ownerDeviceId: ownerDeviceId) as CFDictionary)");
  expect(keychain).not.toContain("versionedAccount");
  const pair = section(source, "    func pair(", "    func remove(");
  expect(pair).toContain('BridgeRequest(method: "POST", path: "/pair", body: body)');
  expect(pair).toContain('BridgeRequest(method: "GET", path: "/state")');
  before(pair, "guard !document.ownerDeviceId.isEmpty", "RemoteMacPairingStore.save(pairing)");
  before(pair, "document.ownerDeviceId != localOwner", "RemoteMacPairingStore.save(pairing)");
  expect(swift("RemoteMacViews.swift")).toContain('Button("Add another Mac…")');
  expect(swift("RemoteMacViews.swift")).toContain('private var port = "8674"');
  expect(swift("RemoteMacViews.swift")).toContain('Button("Remove") { remotes.remove(pairing) }');
  expect(swift("PairingView.swift")).toContain("RemoteMacPairingsView()");
  expect(swift("ConchMacApp.swift").match(/\.environmentObject\(remotes\)/g)).toHaveLength(2);
});

test("A1 Swift observer transport polls old bridges and fetches reply/files only over HTTP", () => {
  const transport = swift("DirectHTTPTransport.swift");
  expect(transport).toContain('URLQueryItem(name: "role", value: "observer")');
  expect(transport).toContain('supportsObserver = response.headers["x-conch-observer"] == "1"');
  before(transport, "if supportsObserver {", "try await receiveStream()");
  expect(transport).toContain("if !streaming {");
  expect(transport).toContain("if !streaming { onStateData?(response.body) }");
  expect(transport).toContain('BridgeRequest(method: "GET", path: "/state")');
  expect(transport).toContain("completionHandler(nil)");
  expect(transport).toContain('components.path = "/file"');
  expect(transport).toContain('URLQueryItem(name: "path", value: path)');
  expect(transport).toContain("session.download(for: urlRequest(request))");
  expect(transport).not.toMatch(/phone-speaking|audio-sink|phone-device|RelayTransport/);
  const store = swift("RemoteMacStore.swift");
  expect(store).toContain('parts.path = "/reply"');
  expect(store).toContain('URLQueryItem(name: "session", value: target.localSessionKey)');
  for (const file of ["DirectHTTPTransport.swift", "RemoteMacStore.swift", "RemoteMacViews.swift"]) {
    expect(source("mac-app/conch-mac.xcodeproj/project.pbxproj")).toContain(`${file} in Sources`);
  }
  expect(source("mac-app/conch-mac/Info.plist")).toContain("<key>NSAllowsLocalNetworking</key>");
});
