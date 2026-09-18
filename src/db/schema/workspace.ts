import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./user";

export const roleEnum = pgEnum("role", ["owner", "admin", "member"]);
export const inviteScopeEnum = pgEnum("invite_scope", ["workspace", "board"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ownerId: uuid("owner_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    role: roleEnum("role").default("member").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("workspace_user_unique_idx").on(table.workspaceId, table.userId),
  ],
);

export const boards = pgTable("boards", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  backgroundColor: text("background_color").default("blue").notNull(),
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const boardMembers = pgTable(
  "board_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .references(() => boards.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: roleEnum("role").default("member").notNull(),
  },
  (table) => [unique("board_user_unique_idx").on(table.boardId, table.userId)],
);

export const lists = pgTable(
  "lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .references(() => boards.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    position: integer("position").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("lists_board_position_idx").on(table.boardId, table.position),
  ],
);

export const cards = pgTable(
  "cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id")
      .references(() => lists.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    description: text("description"),
    position: integer("position").default(0).notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    isArchived: boolean("is_archived").default(false).notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("cards_list_position_idx").on(table.listId, table.position),
  ],
);

export const cardMembers = pgTable(
  "card_members",
  {
    cardId: uuid("card_id")
      .references(() => cards.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.userId] })],
);

export const labels = pgTable("labels", {
  id: uuid("id").primaryKey().defaultRandom(),
  boardId: uuid("board_id")
    .references(() => boards.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  color: text("color").notNull(),
});

export const cardLabels = pgTable(
  "card_labels",
  {
    cardId: uuid("card_id")
      .references(() => cards.id, { onDelete: "cascade" })
      .notNull(),
    labelId: uuid("label_id")
      .references(() => labels.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.labelId] })],
);

export const checklists = pgTable("checklists", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id")
    .references(() => cards.id, { onDelete: "cascade" })
    .notNull(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const checklistItems = pgTable("checklist_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  checklistId: uuid("checklist_id")
    .references(() => checklists.id, { onDelete: "cascade" })
    .notNull(),
  title: text("title").notNull(),
  isDone: boolean("is_done").default(false).notNull(),
  position: integer("position").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id")
    .references(() => cards.id, { onDelete: "cascade" })
    .notNull(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const activityLogs = pgTable("activity_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  boardId: uuid("board_id")
    .references(() => boards.id, { onDelete: "cascade" })
    .notNull(),
  cardId: uuid("card_id").references(() => cards.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  token: uuid("token").defaultRandom().notNull().unique(),
  email: text("email").notNull(),
  scope: inviteScopeEnum("scope").notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, {
    onDelete: "cascade",
  }),
  boardId: uuid("board_id").references(() => boards.id, {
    onDelete: "cascade",
  }),
  role: roleEnum("role").default("member").notNull(),
  invitedBy: uuid("invited_by")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

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
