import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Notices in the two apps (daemon notify-user.ts, 2026-11-10, Tyler: "we should also add a way for me to let sessions send
// me messages on my phone via conch that ping and show notification"): the wiring that can't run in a test, held by its
// source. The logic they share is ConchDesign's (PushNoticesTests.swift).

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThan(-1);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from, to);
};

describe("the iPhone app", () => {
  const push = read("mobile/conch-ios/conch-ios/PushNotifications.swift");
  const app = read("mobile/conch-ios/conch-ios/ConchApp.swift");
  const ledger = read("mobile/conch-ios/conch-ios/LedgerView.swift");
  const bridge = read("mobile/conch-ios/conch-ios/BridgeClient.swift");
  const project = read("mobile/conch-ios/conch-ios.xcodeproj/project.pbxproj");

  test("signed with the push entitlement, in both configurations, and the controller is built", () => {
    expect(read("mobile/conch-ios/conch-ios/conch-ios.entitlements")).toMatch(/<key>aps-environment<\/key>\s*<string>development<\/string>/);
    expect(project.match(/CODE_SIGN_ENTITLEMENTS = "conch-ios\/conch-ios\.entitlements";/g)).toHaveLength(2);
    expect(project).toContain("PushNotifications.swift in Sources */,");
    // Alerts need no background mode: only `audio` is declared, as before.
    expect(read("mobile/conch-ios/conch-ios/Info.plist")).not.toContain("remote-notification");
  });

  test("the delegate is the app's from launch, so a tap that opens the app is routed; Apple's token goes to the controller", () => {
    expect(app).toContain("@UIApplicationDelegateAdaptor(ConchPhoneAppDelegate.self) private var appDelegate");
    const delegate = between(push, "final class ConchPhoneAppDelegate", "/// The ledger's offer");
    expect(delegate).toContain("PushNotifications.shared.start()");
    expect(delegate).toContain("PushNotifications.shared.didRegister(deviceToken: deviceToken)");
    expect(delegate).toContain("PushNotifications.shared.didFailToRegister(error)");
    expect(between(push, "func start() {", "func refresh() async {")).toContain("center.delegate = self");
  });

  test("registered with Apple only once allowed; the Mac told on every connect and when iOS Settings change it", () => {
    const refresh = between(push, "func refresh() async {", "func turnOn() async {");
    expect(refresh).toMatch(/if now == \.allowed \{\s*UIApplication\.shared\.registerForRemoteNotifications\(\)/);
    expect(app).toContain("await PushNotifications.shared.connected(created, install: install)");
    expect(between(app, "case .active:", "case .background:")).toContain("await PushNotifications.shared.refresh()");
    // The registration names the install, the environment the profile says and the app as the topic.
    const send = between(push, "private func send() async {", "private static var provisioningProfile");
    expect(send).toContain("PushEnvironment.from(provisioningProfile: Self.provisioningProfile, debugBuild: Self.debugBuild)");
    expect(send).toContain("topic: Bundle.main.bundleIdentifier");
    expect(send).toContain("alerts: authorization == .allowed");
    expect(between(bridge, "func registerPush(", "/// `pause` or `resume`")).toContain('authorizedRequest(method: "POST", path: "/push-token", body: body)');
    expect(between(bridge, "func pushState(", "func registerPush(")).toContain('components.path = "/push"');
    // The token is never printed or logged.
    expect(push).not.toMatch(/print\(|NSLog\(|os_log|Logger\(/);
  });

  test("in front, a notice is the app's own banner, not a second one; a tap opens its session", () => {
    const willPresent = between(push, "willPresent notification: UNNotification", "/// A tap:");
    expect(willPresent).toContain("self.banner = banner");
    expect(willPresent).toContain("return [.list]");
    const didReceive = between(push, "didReceive response: UNNotificationResponse", "/// The app delegate");
    expect(didReceive).toContain("NoticeRoute.from(userInfo: info)");
    expect(didReceive).toContain("response.actionIdentifier == NoticeRoute.openLinkAction");
    const routing = between(ledger, ".onChange(of: push.pendingRoute, initial: true)", "case .app:");
    expect(routing).toMatch(/case let \.session\(id\):[\s\S]*path = \[id\]/);
    expect(routing).toMatch(/case \.providers:[\s\S]*showingSettings = true/);
    expect(ledger).toContain("NoticeBannerView(");
    expect(ledger).toMatch(/if push\.showsOffer, bridge\.isConnected \{\s*PushOfferRow\(/);
    expect(read("mobile/conch-ios/conch-ios/SettingsView.swift")).toContain("PushSettingsRow(push: PushNotifications.shared, bridge: bridge)");
    // A notice's link goes through the phone's one door (A13, open-link.test.ts).
    expect(between(push, "func openLink(_ url: URL, route: NoticeRoute)", "extension PushNotifications")).toContain("bridge.openLink(url, sessionId: session)");
  });
});

describe("the Mac app", () => {
  const delivery = read("mac-app/conch-mac/NoticeDelivery.swift");
  const appSource = read("mac-app/conch-mac/ConchMacApp.swift");
  const settings = read("mac-app/conch-mac/PushSettingsView.swift");
  const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");

  test("the sessions file's notices are decoded, posted once and answered; a remote Mac's are never handled", () => {
    expect(project).toContain("NoticeDelivery.swift in Sources */,");
    expect(project).toContain("PushSettingsView.swift in Sources */,");
    expect(read("mac-app/conch-mac/Models.swift")).toContain("notices = Self.decodeLossyArray(ConchNotice.self, from: container, forKey: .notices)");
    const store = read("mac-app/conch-mac/StateStore.swift");
    expect(store).toContain("notices.handle(snapshot.notices)");
    expect(store).toContain("notices: sourceState.notices,");
    expect(read("mac-app/conch-mac/RemoteMacStore.swift")).not.toContain("notices");
    expect(delivery).toContain("ReviewNotifications.shared.post(notices: notices)");
    expect(delivery).toContain('let kind = "notice-answer"');
    const post = between(appSource, "func post(notices: [ConchNotice]", "private func deliver(");
    expect(post).toContain("NoticePosting.due(notices, posted: posted)");
    expect(post).toContain("NoticePosting.remember(due, in: posted)");
  });

  test("a notice pings, asks for permission on its own first need, and says whether it showed", () => {
    const deliver = between(appSource, "private func deliver(", "private var didAskForNotice");
    expect(deliver).toContain("content.sound = .default");
    expect(deliver).toContain("content.userInfo = NoticeRoute.userInfo(for: notice)");
    expect(deliver).toMatch(/case \.authorized:[\s\S]*answer\(notice\.id, error == nil \? "shown" : "failed"/);
    expect(deliver).toMatch(/case \.denied:\s*answer\(notice\.id, "off", nil\)/);
    expect(deliver).toMatch(/case \.notAsked:[\s\S]*answer\(notice\.id, "asking", nil\)[\s\S]*requestAuthorization/);
  });

  test("a click goes to the session, Settings › Providers or the link", () => {
    expect(appSource).toContain("NoticeTaps.registerCategories(on: center)");
    expect(between(appSource, "didReceive response: UNNotificationResponse", "final class ReviewNotifications")).toContain("NoticeTaps.open(response)");
    const open = between(delivery, "static func open(_ response: UNNotificationResponse)", "\n    }\n}");
    expect(open).toContain("case let .session(id): ConchStatusItem.openSession(id)");
    expect(open).toContain("case .providers: SettingsRouter.shared.open(.providers)");
    // Through the app's one door (A13, open-link.test.ts).
    expect(open).toContain("store?.openLink(link.absoluteString, cwd: nil, rowId: session, onFailure: { _ in })");
  });

  test("Settings › Phone app: the key goes once, in set alone, and the field is cleared whatever the daemon says", () => {
    expect(read("mac-app/conch-mac/PairingView.swift")).toContain("PushSettingsSection()");
    expect(settings).toContain('let kind = "push-setup"');
    const save = between(settings, "private func save() {", "private func close() {");
    expect(save).toMatch(/let given = key\s*key = ""/);
    expect(settings).toContain('.onDisappear { key = "" }');
    // Never kept: no UserDefaults, no AppStorage, no logging of it.
    expect(settings).not.toMatch(/UserDefaults\.|@AppStorage|print\(|NSLog\(/);
    expect(settings).toContain("SecureField(");
  });
});
