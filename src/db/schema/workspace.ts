import { relations } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import {
  bool,
  enumText,
  id,
  json,
  randomUuid,
  timestamp,
  uuidRef,
} from "./columns";
import { users } from "./user";

export const roleEnum = enumText(["owner", "admin", "member"]);
export const inviteScopeEnum = enumText(["workspace", "board"]);
export const planEnum = enumText(["free", "pro", "business"]);
export const billingStatusEnum = enumText([
  "inactive",
  "active",
  "past_due",
  "cancelled",
]);
export const billingIntervalEnum = enumText(["month", "year"]);
export const priorityEnum = enumText(["low", "medium", "high", "urgent"]);

export const approvalStatusEnum = enumText([
  "none",
  "pending",
  "approved",
  "changes_requested",
]);
export const clientFeedbackKindEnum = enumText([
  "comment",
  "approved",
  "changes_requested",
  "request",
]);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: id("id"),
    name: text("name").notNull(),
    brandName: text("brand_name"),
    brandColor: text("brand_color"),
    brandLogoUrl: text("brand_logo_url"),
    /** Slack incoming webhook (a secret; never sent to the browser). */
    slackWebhookUrl: text("slack_webhook_url"),
    slackChannel: text("slack_channel"),
    slackTeam: text("slack_team"),
    /** Which events post to Slack; null means the defaults. */
    slackEvents: text("slack_events", { mode: "json" }).$type<string[]>(),
    ownerId: uuidRef("owner_id")
      .references(() => users.id, { onDelete: "restrict" })
      .notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [index("workspaces_owner_idx").on(table.ownerId)],
);

export const subscriptions = sqliteTable("subscriptions", {
  userId: uuidRef("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  plan: planEnum("plan").default("free").notNull(),
  billingStatus: billingStatusEnum("billing_status")
    .default("inactive")
    .notNull(),
  paypalSubscriptionId: text("paypal_subscription_id").unique(),
  dodoSubscriptionId: text("dodo_subscription_id").unique(),
  dodoCustomerId: text("dodo_customer_id"),
  billingInterval: billingIntervalEnum("billing_interval")
    .default("month")
    .notNull(),
  discountCodeId: uuidRef("discount_code_id"),
  currentPeriodEnd: timestamp("current_period_end"),
  aiRequestsThisMonth: integer("ai_requests_this_month").default(0).notNull(),
  aiPeriodStart: timestamp("ai_period_start")
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => new Date())
    .notNull(),
});

export const aiUsageEvents = sqliteTable(
  "ai_usage_events",
  {
    id: id("id"),
    userId: uuidRef("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    feature: text("feature").notNull(),
    inputCharacters: integer("input_characters").default(0).notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    estimatedCostMicrousd: integer("estimated_cost_microusd")
      .default(0)
      .notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("ai_usage_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const discountCodes = sqliteTable(
  "discount_codes",
  {
    id: id("id"),
    code: text("code").notNull().unique(),
    percentOff: integer("percent_off").notNull(),
    plan: planEnum("discount_plan"),
    maxRedemptions: integer("max_redemptions"),
    redemptionCount: integer("redemption_count").default(0).notNull(),
    active: bool("active").default(true).notNull(),
    startsAt: timestamp("starts_at"),
    expiresAt: timestamp("expires_at"),
    paypalProPlanId: text("paypal_pro_plan_id").unique(),
    paypalBusinessPlanId: text("paypal_business_plan_id").unique(),
    /** Matching Dodo discount, created on first checkout that uses the code. */
    dodoDiscountId: text("dodo_discount_id"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [index("discount_code_active_idx").on(table.active, table.code)],
);

export const discountRedemptions = sqliteTable(
  "discount_redemptions",
  {
    id: id("id"),
    discountCodeId: uuidRef("discount_code_id")
      .references(() => discountCodes.id, { onDelete: "restrict" })
      .notNull(),
    userId: uuidRef("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    plan: planEnum("plan").notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("discount_redemption_code_user_idx").on(
      table.discountCodeId,
      table.userId,
    ),
  ],
);

export const paymentEvents = sqliteTable(
  "payment_events",
  {
    id: id("id"),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull().unique(),
    providerSubscriptionId: text("provider_subscription_id"),
    userId: uuidRef("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    plan: planEnum("plan"),
    /** month | year at the time of payment (null for old rows). */
    billingInterval: text("billing_interval"),
    status: text("status").notNull(),
    amount: text("amount").notNull(),
    currency: text("currency").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("payment_event_occurred_idx").on(table.occurredAt),
    index("payment_event_user_idx").on(table.userId),
    index("payment_event_subscription_idx").on(table.providerSubscriptionId),
  ],
);

export const billingPlans = sqliteTable("billing_plans", {
  plan: planEnum("plan").primaryKey(),
  paypalProductId: text("paypal_product_id").notNull(),
  paypalPlanId: text("paypal_plan_id").notNull().unique(),
  priceUsd: integer("price_usd").notNull(),
  active: bool("active").default(true).notNull(),
  createdAt: timestamp("created_at")
    .$defaultFn(() => new Date())
    .notNull(),
});

/** PayPal yearly plans (monthly ones live in billing_plans). */
export const annualBillingPlans = sqliteTable("annual_billing_plans", {
  plan: planEnum("plan").primaryKey(),
  paypalProductId: text("paypal_product_id").notNull(),
  paypalPlanId: text("paypal_plan_id").notNull().unique(),
  priceUsd: integer("price_usd").notNull(),
  active: bool("active").default(true).notNull(),
  createdAt: timestamp("created_at")
    .$defaultFn(() => new Date())
    .notNull(),
});

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    id: id("id"),
    userId: uuidRef("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    workspaceId: uuidRef("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    role: roleEnum("role").default("member").notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("workspace_user_unique_idx").on(table.workspaceId, table.userId),
    index("workspace_members_user_idx").on(table.userId),
  ],
);

export const boards = sqliteTable(
  "boards",
  {
    id: id("id"),
    workspaceId: uuidRef("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    backgroundColor: text("background_color").default("blue").notNull(),
    template: text("template").default("blank").notNull(),
    portalToken: text("portal_token").unique(),
    portalEnabled: bool("portal_enabled").default(false).notNull(),
    portalClientName: text("portal_client_name"),
    portalClientEmail: text("portal_client_email"),
    portalWelcome: text("portal_welcome"),
    portalAllowRequests: bool("portal_allow_requests").default(true).notNull(),
    /** Opt-in: AI writes and emails the client update every Friday. */
    portalWeeklyUpdates: bool("portal_weekly_updates").default(false).notNull(),
    portalLastAutoUpdateAt: timestamp("portal_last_auto_update_at"),
    createdBy: uuidRef("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [index("boards_workspace_idx").on(table.workspaceId)],
);

export const boardMembers = sqliteTable(
  "board_members",
  {
    id: id("id"),
    boardId: uuidRef("board_id")
      .references(() => boards.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuidRef("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: roleEnum("role").default("member").notNull(),
  },
  (table) => [
    unique("board_user_unique_idx").on(table.boardId, table.userId),
    index("board_members_user_idx").on(table.userId),
  ],
);

export const lists = sqliteTable(
  "lists",
  {
    id: id("id"),
    boardId: uuidRef("board_id")
      .references(() => boards.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    /** Template role: "intake" | "active" | "review" | "done" (see lib/templates). */
    role: text("role", { enum: ["intake", "active", "review", "done"] }),
    position: integer("position").default(0).notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("lists_board_position_idx").on(table.boardId, table.position),
  ],
);

export const cards = sqliteTable(
  "cards",
  {
    id: id("id"),
    listId: uuidRef("list_id")
      .references(() => lists.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    description: text("description"),
    position: integer("position").default(0).notNull(),
    createdBy: uuidRef("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    isArchived: bool("is_archived").default(false).notNull(),
    isCompleted: bool("is_completed").default(false).notNull(),
    completedAt: timestamp("completed_at"),
    category: text("category").default("task").notNull(),
    dueDate: timestamp("due_date"),
    priority: priorityEnum("priority").default("medium").notNull(),
    estimateMinutes: integer("estimate_minutes"),
    /** Template-specific fields (platforms, caption, proof link…). */
    fields: text("fields", { mode: "json" }).$type<
      Record<string, string | number | string[]>
    >(),
    clientVisible: bool("client_visible").default(true).notNull(),
    approvalStatus: approvalStatusEnum("approval_status")
      .default("none")
      .notNull(),
    approvalRequestedAt: timestamp("approval_requested_at"),
    approvalRespondedAt: timestamp("approval_responded_at"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp("updated_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("cards_list_position_idx").on(table.listId, table.position),
  ],
);

export const cardMembers = sqliteTable(
  "card_members",
  {
    cardId: uuidRef("card_id")
      .references(() => cards.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuidRef("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.userId] }),
    index("card_members_user_idx").on(t.userId),
  ],
);

export const labels = sqliteTable(
  "labels",
  {
    id: id("id"),
    boardId: uuidRef("board_id")
      .references(() => boards.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    color: text("color").notNull(),
  },
  (table) => [index("labels_board_idx").on(table.boardId)],
);

export const cardLabels = sqliteTable(
  "card_labels",
  {
    cardId: uuidRef("card_id")
      .references(() => cards.id, { onDelete: "cascade" })
      .notNull(),
    labelId: uuidRef("label_id")
      .references(() => labels.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cardId, t.labelId] }),
    index("card_labels_label_idx").on(t.labelId),
  ],
);

export const checklists = sqliteTable(
  "checklists",
  {
    id: id("id"),
    cardId: uuidRef("card_id")
      .references(() => cards.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [index("checklists_card_idx").on(table.cardId)],
);

export const checklistItems = sqliteTable(
  "checklist_items",
  {
    id: id("id"),
    checklistId: uuidRef("checklist_id")
      .references(() => checklists.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    isDone: bool("is_done").default(false).notNull(),
    position: integer("position").default(0).notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("checklist_items_checklist_idx").on(
      table.checklistId,
      table.position,
    ),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: id("id"),
    cardId: uuidRef("card_id")
      .references(() => cards.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuidRef("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [index("comments_card_idx").on(table.cardId, table.createdAt)],
);

/**
 * Files attached to cards (designs, drafts, videos) for client proofing.
 * Bytes live in R2 under `storageKey`; this row is the index and quota
 * source. workspaceId is kept so storage can be summed per owner cheaply.
 */
export const cardFiles = sqliteTable(
  "card_files",
  {
    id: id("id"),
    cardId: uuidRef("card_id")
      .references(() => cards.id, { onDelete: "cascade" })
      .notNull(),
    boardId: uuidRef("board_id")
      .references(() => boards.id, { onDelete: "cascade" })
      .notNull(),
    workspaceId: uuidRef("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    uploadedBy: uuidRef("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("card_files_card_idx").on(table.cardId, table.createdAt),
    index("card_files_workspace_idx").on(table.workspaceId),
    index("card_files_board_idx").on(table.boardId),
  ],
);

export const clientFeedback = sqliteTable(
  "client_feedback",
  {
    id: id("id"),
    boardId: uuidRef("board_id")
      .references(() => boards.id, { onDelete: "cascade" })
      .notNull(),
    cardId: uuidRef("card_id").references(() => cards.id, {
      onDelete: "cascade",
    }),
    kind: clientFeedbackKindEnum("kind").notNull(),
    authorName: text("author_name").notNull(),
    message: text("message").notNull(),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("client_feedback_board_created_idx").on(
      table.boardId,
      table.createdAt,
    ),
    index("client_feedback_card_idx").on(table.cardId),
  ],
);

export const activityLogs = sqliteTable(
  "activity_logs",
  {
    id: id("id"),
    userId: uuidRef("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    boardId: uuidRef("board_id")
      .references(() => boards.id, { onDelete: "cascade" })
      .notNull(),
    cardId: uuidRef("card_id").references(() => cards.id, {
      onDelete: "cascade",
    }),
    action: text("action").notNull(),
    meta: json("meta"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("activity_logs_board_idx").on(table.boardId, table.createdAt),
    index("activity_logs_card_idx").on(table.cardId),
  ],
);

export const invites = sqliteTable(
  "invites",
  {
    id: id("id"),
    token: randomUuid("token").notNull().unique(),
    email: text("email").notNull(),
    scope: inviteScopeEnum("scope").notNull(),
    workspaceId: uuidRef("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    boardId: uuidRef("board_id").references(() => boards.id, {
      onDelete: "cascade",
    }),
    role: roleEnum("role").default("member").notNull(),
    invitedBy: uuidRef("invited_by")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("invites_workspace_idx").on(table.workspaceId),
    index("invites_board_idx").on(table.boardId),
    // "Invites for me" on every dashboard load.
    index("invites_email_idx").on(table.email),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  workspaceMemberships: many(workspaceMembers),
  boardMemberships: many(boardMembers),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  owner: one(users, {
    fields: [workspaces.ownerId],
    references: [users.id],
  }),
  members: many(workspaceMembers),
  boards: many(boards),
}));

export const boardsRelations = relations(boards, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [boards.workspaceId],
    references: [workspaces.id],
  }),
  members: many(boardMembers),
  lists: many(lists),
  labels: many(labels),
}));

export const listsRelations = relations(lists, ({ one, many }) => ({
  board: one(boards, { fields: [lists.boardId], references: [boards.id] }),
  cards: many(cards),
}));

export const cardsRelations = relations(cards, ({ one, many }) => ({
  list: one(lists, { fields: [cards.listId], references: [lists.id] }),
  members: many(cardMembers),
  labels: many(cardLabels),
  checklists: many(checklists),
  comments: many(comments),
  files: many(cardFiles),
}));

export const cardFilesRelations = relations(cardFiles, ({ one }) => ({
  card: one(cards, { fields: [cardFiles.cardId], references: [cards.id] }),
}));

export const workspaceMembersRelations = relations(
  workspaceMembers,
  ({ one }) => ({
    user: one(users, {
      fields: [workspaceMembers.userId],
      references: [users.id],
    }),
    workspace: one(workspaces, {
      fields: [workspaceMembers.workspaceId],
      references: [workspaces.id],
    }),
  }),
);

export const boardMembersRelations = relations(boardMembers, ({ one }) => ({
  user: one(users, { fields: [boardMembers.userId], references: [users.id] }),
  board: one(boards, {
    fields: [boardMembers.boardId],
    references: [boards.id],
  }),
}));

export const cardMembersRelations = relations(cardMembers, ({ one }) => ({
  user: one(users, { fields: [cardMembers.userId], references: [users.id] }),
  card: one(cards, { fields: [cardMembers.cardId], references: [cards.id] }),
}));

export const labelsRelations = relations(labels, ({ one, many }) => ({
  board: one(boards, { fields: [labels.boardId], references: [boards.id] }),
  cards: many(cardLabels),
}));

export const cardLabelsRelations = relations(cardLabels, ({ one }) => ({
  card: one(cards, { fields: [cardLabels.cardId], references: [cards.id] }),
  label: one(labels, { fields: [cardLabels.labelId], references: [labels.id] }),
}));

export const checklistsRelations = relations(checklists, ({ one, many }) => ({
  card: one(cards, { fields: [checklists.cardId], references: [cards.id] }),
  items: many(checklistItems),
}));

export const checklistItemsRelations = relations(checklistItems, ({ one }) => ({
  checklist: one(checklists, {
    fields: [checklistItems.checklistId],
    references: [checklists.id],
  }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  card: one(cards, { fields: [comments.cardId], references: [cards.id] }),
  user: one(users, { fields: [comments.userId], references: [users.id] }),
}));

export const invitesRelations = relations(invites, ({ one }) => ({
  inviter: one(users, { fields: [invites.invitedBy], references: [users.id] }),
}));
