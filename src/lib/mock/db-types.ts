import type {
  AccessRequest,
  ActivityEntry,
  AuditEntry,
  Epic,
  Label,
  Milestone,
  Notification,
  NotificationPreferences,
  Objective,
  Permission,
  Project,
  RichDoc,
  RoleScope,
  Sprint,
  Status,
  Task,
  User,
  Comment,
  Attachment,
} from "@/lib/api/types";

/* Stored shapes. Derived fields (progress, counts, my_permissions) are computed per request. */

export type UserRec = User & { password: string };
export type WorkspaceRec = { id: string; slug: string; name: string; hue: number; createdAt: string; deletedAt: string | null };
export type WsMemberRec = {
  workspaceId: string;
  userId: string;
  roleId: string;
  status: "active" | "deactivated";
  joinedAt: string;
  lastActiveAt: string | null;
};
export type RoleRec = {
  id: string;
  workspaceId: string;
  key: string | null;
  name: string;
  description: string;
  scope: RoleScope;
  isSystem: boolean;
  permissions: Permission[];
};
export type InviteRec = {
  id: string;
  token: string;
  workspaceId: string;
  email: string;
  roleId: string;
  invitedById: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "accepted" | "revoked" | "expired";
};
export type ProjectRec = Omit<
  Project,
  "my_permissions" | "myRoleId" | "memberCount" | "openTaskCount" | "activeSprintId"
> & { taskSeq: number };
export type ProjectMemberRec = { projectId: string; userId: string; roleId: string; addedAt: string };
export type ObjectiveRec = Omit<Objective, "progress" | "taskIds">;
export type MilestoneRec = Omit<Milestone, "progress">;
export type EpicRec = Omit<Epic, "progress">;
export type SprintRec = Omit<Sprint, "progress">;
export type TaskRec = Omit<Task, "subtaskCount" | "subtaskDoneCount" | "commentCount" | "attachmentCount"> & {
  description: RichDoc | null;
  startedAt: string | null;
};
export type AttachmentRec = Attachment & { content?: string };
export type NotificationRec = Notification & { recipientId: string };

export interface MockDB {
  schema: number;
  users: UserRec[];
  workspaces: WorkspaceRec[];
  wsMembers: WsMemberRec[];
  roles: RoleRec[];
  invites: InviteRec[];
  projects: ProjectRec[];
  projectMembers: ProjectMemberRec[];
  accessRequests: AccessRequest[];
  statuses: Status[];
  labels: Label[];
  objectives: ObjectiveRec[];
  milestones: MilestoneRec[];
  epics: EpicRec[];
  sprints: SprintRec[];
  tasks: TaskRec[];
  comments: Comment[];
  attachments: AttachmentRec[];
  notifications: NotificationRec[];
  prefs: { userId: string; prefs: NotificationPreferences }[];
  activity: ActivityEntry[];
  audit: (AuditEntry & { workspaceId: string })[];
  resetTokens: { token: string; userId: string; expiresAt: string }[];
  recents: { userId: string; kind: "task" | "project"; id: string; at: string }[];
}
