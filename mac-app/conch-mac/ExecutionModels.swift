import Foundation

/// Local/remote is relative to the viewer. Both refer to a stable device runtime.
struct RuntimeLocation: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let kind: String
    let label: String
    let ownerDeviceId: String?
    let providerId: String?
    let workspaceId: String?
}
struct ProviderAccount: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let providerId: String
    let label: String
    let identity: String
    let subject: String?
}
struct ProviderConnection: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let providerId: String
    let runtimeId: String
    let accountId: String?
    let profileId: String?
}
struct ExecutionCatalog: Decodable, Equatable, Sendable {
    let runtimes: [RuntimeLocation]
    let accounts: [ProviderAccount]
    let connections: [ProviderConnection]
}
struct SessionExecution: Decodable, Equatable, Sendable {
    let providerId: String
    let runtimeId: String
    let connectionId: String?
}
