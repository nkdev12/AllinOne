export type ShareRole = "VIEWER" | "EDITOR" | "ADMIN";

export type ResourceType = "NOTE" | "PROJECT" | "CALENDAR";

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

