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
import aiRouter from "./ai";
import billingRouter from "./billing";
import adminRouter from "./admin";

const api = new Hono<AppEnv>();

api.use("*", auth);
api.route("/", workspacesRouter);
api.route("/", boardsRouter);
api.route("/", cardsRouter);
api.route("/", checklistsRouter);
api.route("/", commentsRouter);
api.route("/", labelsAndActivityRouter);
api.route("/", invitesRouter);
api.route("/", aiRouter);
api.route("/", billingRouter);
api.route("/", adminRouter);

export default api;
