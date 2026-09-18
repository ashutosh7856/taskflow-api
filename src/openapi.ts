const routeMethods: Record<string, string[]> = {
  "/auth/register": ["post"],
  "/auth/login": ["post"],
  "/auth/refresh": ["post"],
  "/auth/me": ["get"],
  "/workspaces": ["get", "post"],
  "/workspaces/{id}": ["get", "patch", "delete"],
  "/workspaces/{id}/members": ["post"],
  "/workspaces/{id}/members/{userId}": ["delete"],
  "/workspaces/{id}/invites": ["post"],
  "/workspaces/{workspaceId}/boards": ["get", "post"],
  "/boards/{id}": ["get", "patch", "delete"],
  "/boards/{id}/members": ["post"],
  "/boards/{id}/members/{userId}": ["delete"],
  "/boards/{id}/invites": ["post"],
  "/boards/{boardId}/lists": ["post"],
  "/lists/{id}": ["patch", "delete"],
  "/lists/{listId}/cards": ["post"],
  "/cards/{id}": ["get", "patch", "delete"],
  "/cards/{id}/members": ["post"],
  "/cards/{id}/members/{userId}": ["delete"],
  "/cards/{id}/labels": ["post"],
  "/cards/{id}/labels/{labelId}": ["delete"],
  "/cards/{cardId}/checklists": ["post"],
  "/checklists/{id}/items": ["post"],
  "/checklist-items/{id}": ["patch", "delete"],
  "/cards/{cardId}/comments": ["get", "post"],
  "/comments/{id}": ["delete"],
  "/boards/{boardId}/labels": ["get", "post"],
  "/labels/{id}": ["delete"],
  "/boards/{boardId}/activity": ["get"],
  "/cards/{cardId}/activity": ["get"],
  "/invites/{token}/accept": ["post"],
};

const paths: Record<string, unknown> = {};

for (const [path, methods] of Object.entries(routeMethods)) {
  paths[path] = Object.fromEntries(
    methods.map((method) => [
      method,
      {
        summary: `${method.toUpperCase()} ${path}`,
        security:
          path.startsWith("/auth/") && path !== "/auth/me"
            ? []
            : [{ bearerAuth: [] }],
        parameters: [...path.matchAll(/\{(\w+)\}/g)].map((match) => ({
          name: match[1],
          in: "path",
          required: true,
          schema: { type: "string" },
        })),
        requestBody: ["post", "patch"].includes(method)
          ? {
              required: true,
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true },
                },
              },
            }
          : undefined,
        responses: {
          "200": { description: "Success" },
          "201": { description: "Created" },
          "204": { description: "No content" },
          "400": { description: "Invalid request" },
          "401": { description: "Unauthorized" },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
        },
      },
    ]),
  );
}

export const openApi = {
  openapi: "3.0.3",
  info: { title: "Trello Clone API", version: "1.0.0" },
  servers: [{ url: "/" }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
  },
};
