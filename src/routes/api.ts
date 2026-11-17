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
import dodoRouter from "./dodo";
import adminRouter from "./admin";
import portalRouter from "./portal";
import filesRouter from "./files";
import { slackRouter } from "./slack";
import tasksRouter from "./tasks";

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
api.route("/", dodoRouter);
api.route("/", portalRouter);
api.route("/", filesRouter);
api.route("/", slackRouter);
api.route("/", tasksRouter);
// adminRouter guards "*" with an admin check, so it must stay mounted last.
api.route("/", adminRouter);

export default api;
