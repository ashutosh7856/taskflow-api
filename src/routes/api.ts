import { Hono } from "hono";

import type { AppEnv } from "../lib/http";
import { auth } from "../middleware/auth";
import boardsRouter from "./boards";
import cardsRouter from "./cards";
import checklistsRouter from "./checklists";
import commentsRouter from "./comments";
import invitesRouter from "./invites";
import labelsAndActivityRouter from "./labels-and-activity";
import workspacesRouter from "./workspaces";

const api = new Hono<AppEnv>();

api.use("*", auth);
api.route("/", workspacesRouter);
api.route("/", boardsRouter);
api.route("/", cardsRouter);
api.route("/", checklistsRouter);
api.route("/", commentsRouter);
api.route("/", labelsAndActivityRouter);
api.route("/", invitesRouter);

export default api;
