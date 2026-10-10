export type ShareRole = "VIEWER" | "EDITOR" | "ADMIN";

export type ResourceType =
  | "NOTE"
  | "PROJECT"
  | "CALENDAR"
  | "EXPENSE_GROUP"
  | "TRIP";

/**
 * The response shape `/collaboration` publishes — keys are load-bearing for
 * `docs/API_REFERENCE.md` and the Flutter client, so they survive the move from
 * process memory to the `ResourceShare` collection. The database columns are
 * `Date`s; `createdAt`/`updatedAt` are mapped back to ISO strings by
 * `CollaborationService.toResourceShare`.
 *
 * `sharedWithUserId` stays optional in the type but is always set on rows this
 * service writes: a grant needs a registered account behind it, because the
 * consumers of `checkAccess` match on the caller's id.
 */
export interface ResourceShare {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  ownerId: string;
  sharedWithUserId?: string;
  sharedWithEmail: string;
  role: ShareRole;
  createdAt: string;
  updatedAt: string;
}

export interface SharePermissionResult {
  hasAccess: boolean;
  role?: ShareRole;
  isOwner: boolean;
}
