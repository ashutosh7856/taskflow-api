/**
 * Board templates: one per kind of client work. Each defines the stages
 * (lists), what a card is called, the fields that kind of work needs, a
 * starter checklist per card type, and the wording used in the app and the
 * client portal. The frontend reads this catalog from GET /templates.
 *
 * List roles drive automation:
 *  - "done": a card moved here is complete; completing a card moves it here.
 *  - "review": client approval stage. Approving moves the card to the next
 *    list; requesting changes moves it back to the previous working list.
 */

export type ListRole = "intake" | "active" | "review" | "done";

export type FieldType =
  "text" | "longtext" | "url" | "date" | "number" | "select" | "multiselect";

export type TemplateField = {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  placeholder?: string;
  /** Shown to the client in the portal. */
  client?: boolean;
  /** Shown on the card tile on the board. */
  onCard?: boolean;
};

export type TemplateCategory = {
  value: string;
  label: string;
  /** Starter checklist added when a card of this type is created. */
  checklist?: string[];
};

export type BoardTemplate = {
  id: string;
  name: string;
  group: "client" | "team";
  description: string;
  cardNoun: string;
  helper: string;
  lists: Array<{ name: string; role: ListRole }>;
  labels: Array<{ name: string; color: string }>;
  categories: TemplateCategory[];
  fields: TemplateField[];
  wording: {
    /** Action to finish a card, e.g. "Mark published". */
    complete: string;
    /** State of a finished card, e.g. "Published". */
    completed: string;
    /** Label for the card's due date, e.g. "Publish date". */
    due: string;
    /** Button that asks the client to approve, e.g. "Send post for approval". */
    requestApproval: string;
    /** The client's approve button in the portal, e.g. "Approve post". */
    approve: string;
  };
};

const PLATFORMS = [
  "Instagram",
  "Facebook",
  "LinkedIn",
  "TikTok",
  "YouTube",
  "X",
  "Threads",
  "Pinterest",
];

export const templates: BoardTemplate[] = [
  {
    id: "client",
    name: "Client project",
    group: "client",
    description: "Any client work: requests, delivery, approvals.",
    cardNoun: "deliverable",
    helper: "Describe what the client will receive and when.",
    lists: [
      { name: "Requests", role: "intake" },
      { name: "In progress", role: "active" },
      { name: "Client review", role: "review" },
      { name: "Done", role: "done" },
    ],
    labels: [
      { name: "Deliverable", color: "#2563eb" },
      { name: "Revision", color: "#ea580c" },
      { name: "Waiting on client", color: "#ca8a04" },
    ],
    categories: [
      { value: "deliverable", label: "Deliverable" },
      { value: "revision", label: "Revision" },
      { value: "request", label: "Client request" },
      { value: "task", label: "Task" },
    ],
    fields: [
      {
        key: "link",
        label: "Preview / file link",
        type: "url",
        placeholder: "https://",
        client: true,
      },
      {
        key: "revision",
        label: "Revision round",
        type: "select",
        options: ["1st", "2nd", "3rd", "Extra (billable)"],
        client: true,
        onCard: true,
      },
    ],
    wording: {
      complete: "Mark done",
      completed: "Done",
      due: "Due date",
      requestApproval: "Send for client approval",
      approve: "Approve",
    },
  },
  {
    id: "social",
    name: "Social media",
    group: "client",
    description: "Content calendar: draft, client approval, schedule, publish.",
    cardNoun: "post",
    helper: "Write the caption, attach the visual, pick platforms and a date.",
    lists: [
      { name: "Ideas", role: "intake" },
      { name: "Drafting", role: "active" },
      { name: "Client approval", role: "review" },
      { name: "Scheduled", role: "active" },
      { name: "Published", role: "done" },
    ],
    labels: [
      { name: "Promo", color: "#db2777" },
      { name: "Evergreen", color: "#16a34a" },
      { name: "Trend", color: "#7c3aed" },
      { name: "Needs assets", color: "#ca8a04" },
    ],
    categories: [
      {
        value: "post",
        label: "Feed post",
        checklist: [
          "Caption written",
          "Visual ready",
          "Hashtags and tags added",
          "Alt text written",
          "Scheduled in the publishing tool",
        ],
      },
      {
        value: "reel",
        label: "Reel / short video",
        checklist: [
          "Hook and script",
          "Footage ready",
          "Edited with captions",
          "Cover image",
          "Scheduled in the publishing tool",
        ],
      },
      {
        value: "carousel",
        label: "Carousel",
        checklist: [
          "Slide copy written",
          "Slides designed",
          "Caption written",
          "Scheduled in the publishing tool",
        ],
      },
      { value: "story", label: "Story" },
      { value: "campaign", label: "Campaign" },
    ],
    fields: [
      {
        key: "platforms",
        label: "Platforms",
        type: "multiselect",
        options: PLATFORMS,
        client: true,
        onCard: true,
      },
      {
        key: "caption",
        label: "Caption",
        type: "longtext",
        placeholder: "The post copy the client will approve",
        client: true,
      },
      {
        key: "asset",
        label: "Visual / asset link",
        type: "url",
        placeholder: "Canva, Drive or Figma link",
        client: true,
      },
      { key: "hashtags", label: "Hashtags", type: "text", client: true },
      {
        key: "liveUrl",
        label: "Live post link",
        type: "url",
        client: true,
      },
    ],
    wording: {
      complete: "Mark published",
      completed: "Published",
      due: "Publish date",
      requestApproval: "Send post for approval",
      approve: "Approve post",
    },
  },
  {
    id: "website",
    name: "Website project",
    group: "client",
    description: "Discovery to launch, page by page, with sign-off gates.",
    cardNoun: "page or task",
    helper: "One card per page or feature. Link the design and the preview.",
    lists: [
      { name: "Discovery & content", role: "intake" },
      { name: "Design", role: "active" },
      { name: "Build", role: "active" },
      { name: "Client review", role: "review" },
      { name: "Live", role: "done" },
    ],
    labels: [
      { name: "Needs content", color: "#ca8a04" },
      { name: "Mobile", color: "#0891b2" },
      { name: "SEO", color: "#16a34a" },
      { name: "Bug", color: "#dc2626" },
    ],
    categories: [
      {
        value: "page",
        label: "Page",
        checklist: [
          "Content received from client",
          "Design approved",
          "Built and responsive",
          "SEO title and meta description",
          "Tested on mobile and desktop",
        ],
      },
      { value: "feature", label: "Feature / integration" },
      { value: "content", label: "Content" },
      { value: "fix", label: "Fix" },
      {
        value: "launch",
        label: "Launch",
        checklist: [
          "Domain and SSL",
          "Redirects from old URLs",
          "Analytics installed",
          "Forms tested",
          "Favicon and social preview image",
          "Speed check",
          "Backup set up",
        ],
      },
    ],
    fields: [
      {
        key: "preview",
        label: "Preview link",
        type: "url",
        placeholder: "Staging URL",
        client: true,
      },
      {
        key: "design",
        label: "Design link",
        type: "url",
        placeholder: "Figma link",
        client: true,
      },
      {
        key: "page",
        label: "Page URL",
        type: "text",
        placeholder: "/about",
        client: true,
        onCard: true,
      },
    ],
    wording: {
      complete: "Mark live",
      completed: "Live",
      due: "Due date",
      requestApproval: "Send for client review",
      approve: "Approve",
    },
  },
  {
    id: "design",
    name: "Design & branding",
    group: "client",
    description: "Brief, concepts, revision rounds and final files.",
    cardNoun: "design",
    helper: "Link the proof, track the revision round, list the file formats.",
    lists: [
      { name: "Brief", role: "intake" },
      { name: "Designing", role: "active" },
      { name: "Client review", role: "review" },
      { name: "Final files", role: "active" },
      { name: "Delivered", role: "done" },
    ],
    labels: [
      { name: "Logo", color: "#7c3aed" },
      { name: "Print", color: "#0891b2" },
      { name: "Digital", color: "#2563eb" },
      { name: "Extra round", color: "#dc2626" },
    ],
    categories: [
      {
        value: "logo",
        label: "Logo",
        checklist: [
          "Brief and moodboard agreed",
          "Initial concepts",
          "Chosen concept refined",
          "Colour, mono and reversed versions",
          "Exported SVG, PNG and PDF",
        ],
      },
      {
        value: "identity",
        label: "Brand identity",
        checklist: [
          "Logo approved",
          "Colour palette",
          "Typography",
          "Brand guidelines document",
          "Final file pack delivered",
        ],
      },
      { value: "graphic", label: "Graphic" },
      { value: "print", label: "Print" },
      { value: "presentation", label: "Presentation" },
    ],
    fields: [
      {
        key: "proof",
        label: "Proof link",
        type: "url",
        placeholder: "Link to the version to review",
        client: true,
      },
      {
        key: "round",
        label: "Revision round",
        type: "select",
        options: [
          "Concepts",
          "1st revision",
          "2nd revision",
          "Extra (billable)",
        ],
        client: true,
        onCard: true,
      },
      {
        key: "formats",
        label: "File formats",
        type: "multiselect",
        options: ["SVG", "PNG", "PDF", "JPG", "AI / EPS", "Figma"],
        client: true,
      },
      {
        key: "size",
        label: "Size / dimensions",
        type: "text",
        placeholder: "1080×1350, A4…",
        client: true,
      },
    ],
    wording: {
      complete: "Mark delivered",
      completed: "Delivered",
      due: "Due date",
      requestApproval: "Send proof for approval",
      approve: "Approve design",
    },
  },
  {
    id: "video",
    name: "Video production",
    group: "client",
    description: "Script, footage, rough and fine cuts, delivery.",
    cardNoun: "video",
    helper: "Track the cut stage, share the review link, list the formats.",
    lists: [
      { name: "Brief & script", role: "intake" },
      { name: "Footage in", role: "active" },
      { name: "Editing", role: "active" },
      { name: "Client review", role: "review" },
      { name: "Delivered", role: "done" },
    ],
    labels: [
      { name: "Long form", color: "#2563eb" },
      { name: "Short form", color: "#db2777" },
      { name: "Waiting on footage", color: "#ca8a04" },
      { name: "Extra round", color: "#dc2626" },
    ],
    categories: [
      {
        value: "video",
        label: "Video",
        checklist: [
          "Footage and assets received",
          "Rough cut",
          "Music and sound",
          "Colour grade",
          "Captions / subtitles",
          "Final export",
        ],
      },
      {
        value: "short",
        label: "Short / reel",
        checklist: [
          "Hook in the first 3 seconds",
          "Edit",
          "Burned-in captions",
          "Vertical export",
        ],
      },
      { value: "thumbnail", label: "Thumbnail" },
      { value: "revision", label: "Revision" },
    ],
    fields: [
      {
        key: "cut",
        label: "Cut",
        type: "select",
        options: ["Rough cut", "Fine cut", "Final"],
        client: true,
        onCard: true,
      },
      {
        key: "review",
        label: "Review link",
        type: "url",
        placeholder: "Frame.io, Drive or YouTube unlisted",
        client: true,
      },
      {
        key: "ratios",
        label: "Formats",
        type: "multiselect",
        options: ["16:9", "9:16", "1:1", "4:5"],
        client: true,
        onCard: true,
      },
      {
        key: "length",
        label: "Target length",
        type: "text",
        placeholder: "60s, 8–10 min…",
        client: true,
      },
      {
        key: "delivery",
        label: "Final files link",
        type: "url",
        client: true,
      },
    ],
    wording: {
      complete: "Mark delivered",
      completed: "Delivered",
      due: "Delivery date",
      requestApproval: "Send cut for approval",
      approve: "Approve cut",
    },
  },
  {
    id: "writing",
    name: "Content writing",
    group: "client",
    description: "Briefs and keywords to approved, published pieces.",
    cardNoun: "piece",
    helper: "Add the target keyword, word count and draft link.",
    lists: [
      { name: "Topics & briefs", role: "intake" },
      { name: "Writing", role: "active" },
      { name: "Client review", role: "review" },
      { name: "Ready to publish", role: "active" },
      { name: "Published", role: "done" },
    ],
    labels: [
      { name: "SEO", color: "#16a34a" },
      { name: "Thought leadership", color: "#7c3aed" },
      { name: "Refresh", color: "#0891b2" },
      { name: "Waiting on info", color: "#ca8a04" },
    ],
    categories: [
      {
        value: "blog",
        label: "Blog post",
        checklist: [
          "Brief and keyword confirmed",
          "Outline approved",
          "Draft written",
          "Edited and proofread",
          "Meta title and description",
          "Images and alt text",
          "Internal links",
        ],
      },
      { value: "newsletter", label: "Newsletter" },
      { value: "landing", label: "Landing page copy" },
      { value: "case_study", label: "Case study" },
      { value: "social_copy", label: "Social copy" },
    ],
    fields: [
      {
        key: "keyword",
        label: "Target keyword",
        type: "text",
        client: true,
        onCard: true,
      },
      {
        key: "words",
        label: "Word count",
        type: "number",
        placeholder: "1500",
        client: true,
        onCard: true,
      },
      {
        key: "draft",
        label: "Draft link",
        type: "url",
        placeholder: "Google Doc link",
        client: true,
      },
      {
        key: "liveUrl",
        label: "Published URL",
        type: "url",
        client: true,
      },
    ],
    wording: {
      complete: "Mark published",
      completed: "Published",
      due: "Due date",
      requestApproval: "Send draft for approval",
      approve: "Approve draft",
    },
  },
  {
    id: "photography",
    name: "Photography",
    group: "client",
    description: "Inquiry to booked shoot, editing and gallery delivery.",
    cardNoun: "shoot",
    helper: "One card per shoot: date, location, package and gallery link.",
    lists: [
      { name: "Inquiries", role: "intake" },
      { name: "Booked", role: "active" },
      { name: "Editing", role: "active" },
      { name: "Proofs with client", role: "review" },
      { name: "Delivered", role: "done" },
    ],
    labels: [
      { name: "Deposit paid", color: "#16a34a" },
      { name: "Contract signed", color: "#2563eb" },
      { name: "Awaiting selection", color: "#ca8a04" },
      { name: "Rush", color: "#dc2626" },
    ],
    categories: [
      {
        value: "session",
        label: "Session",
        checklist: [
          "Contract signed",
          "Deposit paid",
          "Questionnaire and shot list",
          "Shoot done and backed up",
          "Culled",
          "Edited",
          "Gallery delivered",
        ],
      },
      { value: "wedding", label: "Wedding" },
      { value: "event", label: "Event" },
      { value: "product", label: "Product" },
      { value: "headshots", label: "Headshots" },
    ],
    fields: [
      {
        key: "shootDate",
        label: "Shoot date",
        type: "date",
        client: true,
        onCard: true,
      },
      { key: "location", label: "Location", type: "text", client: true },
      { key: "package", label: "Package", type: "text", client: true },
      {
        key: "gallery",
        label: "Gallery link",
        type: "url",
        client: true,
      },
      {
        key: "images",
        label: "Images delivered",
        type: "number",
        client: true,
      },
    ],
    wording: {
      complete: "Mark delivered",
      completed: "Delivered",
      due: "Delivery date",
      requestApproval: "Send proofs for selection",
      approve: "Approve selection",
    },
  },
  {
    id: "marketing",
    name: "Marketing campaigns",
    group: "team",
    description: "Plan, build and launch campaigns across channels.",
    cardNoun: "campaign item",
    helper: "Define the channel, audience, goal and launch date.",
    lists: [
      { name: "Ideas", role: "intake" },
      { name: "Planned", role: "active" },
      { name: "Creating", role: "active" },
      { name: "Approval", role: "review" },
      { name: "Launched", role: "done" },
    ],
    labels: [
      { name: "Social", color: "#db2777" },
      { name: "Email", color: "#7c3aed" },
      { name: "Content", color: "#0891b2" },
      { name: "Paid", color: "#ea580c" },
    ],
    categories: [
      {
        value: "campaign",
        label: "Campaign",
        checklist: [
          "Goal and KPI agreed",
          "Audience defined",
          "Creative and copy ready",
          "Tracking links set up",
          "Launched",
          "Results reported",
        ],
      },
      { value: "content", label: "Content" },
      { value: "email", label: "Email" },
      { value: "ad", label: "Ad" },
      { value: "experiment", label: "Experiment" },
    ],
    fields: [
      {
        key: "channels",
        label: "Channels",
        type: "multiselect",
        options: [
          "Email",
          "Social",
          "Paid ads",
          "SEO / blog",
          "Website",
          "Events",
        ],
        client: true,
        onCard: true,
      },
      { key: "audience", label: "Audience", type: "text", client: true },
      { key: "goal", label: "Goal / KPI", type: "text", client: true },
      { key: "budget", label: "Budget", type: "number", client: true },
      { key: "results", label: "Results link", type: "url", client: true },
    ],
    wording: {
      complete: "Mark launched",
      completed: "Launched",
      due: "Launch date",
      requestApproval: "Send for approval",
      approve: "Approve",
    },
  },
  {
    id: "software",
    name: "Software",
    group: "team",
    description: "Backlog to shipped, with code review.",
    cardNoun: "work item",
    helper: "Add enough context for engineering, review and QA.",
    lists: [
      { name: "Backlog", role: "intake" },
      { name: "Ready", role: "active" },
      { name: "In progress", role: "active" },
      { name: "Review", role: "review" },
      { name: "Shipped", role: "done" },
    ],
    labels: [
      { name: "Bug", color: "#dc2626" },
      { name: "Feature", color: "#2563eb" },
      { name: "Tech debt", color: "#7c3aed" },
      { name: "Blocked", color: "#111827" },
    ],
    categories: [
      {
        value: "feature",
        label: "Feature",
        checklist: [
          "Acceptance criteria",
          "Implemented",
          "Tests",
          "Code reviewed",
          "Deployed",
        ],
      },
      {
        value: "bug",
        label: "Bug",
        checklist: ["Reproduced", "Fixed", "Regression test", "Deployed"],
      },
      { value: "chore", label: "Chore" },
      { value: "spike", label: "Research spike" },
    ],
    fields: [
      {
        key: "points",
        label: "Estimate",
        type: "select",
        options: ["1", "2", "3", "5", "8", "13"],
        onCard: true,
      },
      { key: "pr", label: "Pull request", type: "url" },
      {
        key: "env",
        label: "Environment",
        type: "select",
        options: ["Staging", "Production"],
        client: true,
      },
    ],
    wording: {
      complete: "Mark shipped",
      completed: "Shipped",
      due: "Due date",
      requestApproval: "Ask client to sign off",
      approve: "Sign off",
    },
  },
  {
    id: "operations",
    name: "Operations",
    group: "team",
    description: "Requests and incidents, triaged and resolved.",
    cardNoun: "request",
    helper: "Capture impact, urgency, owner and resolution target.",
    lists: [
      { name: "Requests", role: "intake" },
      { name: "Triage", role: "active" },
      { name: "In progress", role: "active" },
      { name: "Waiting", role: "active" },
      { name: "Resolved", role: "done" },
    ],
    labels: [
      { name: "Incident", color: "#dc2626" },
      { name: "Customer", color: "#2563eb" },
      { name: "Internal", color: "#16a34a" },
      { name: "Blocked", color: "#111827" },
    ],
    categories: [
      { value: "request", label: "Request" },
      {
        value: "incident",
        label: "Incident",
        checklist: [
          "Impact assessed",
          "Owner assigned",
          "Fix applied",
          "Requester updated",
          "Root cause noted",
        ],
      },
      { value: "process", label: "Process improvement" },
      { value: "maintenance", label: "Maintenance" },
    ],
    fields: [
      { key: "requester", label: "Requested by", type: "text", onCard: true },
      {
        key: "impact",
        label: "Impact",
        type: "select",
        options: ["Low", "Medium", "High", "Critical"],
        onCard: true,
      },
      { key: "system", label: "System / area", type: "text" },
    ],
    wording: {
      complete: "Mark resolved",
      completed: "Resolved",
      due: "Target date",
      requestApproval: "Send for approval",
      approve: "Approve",
    },
  },
  {
    id: "blank",
    name: "Blank",
    group: "team",
    description: "Start from a clean board.",
    cardNoun: "task",
    helper: "Capture the outcome and the next action.",
    lists: [],
    labels: [
      { name: "Important", color: "#dc2626" },
      { name: "Quick win", color: "#16a34a" },
    ],
    categories: [
      { value: "task", label: "Task" },
      { value: "milestone", label: "Milestone" },
      { value: "idea", label: "Idea" },
    ],
    fields: [],
    wording: {
      complete: "Mark complete",
      completed: "Completed",
      due: "Due date",
      requestApproval: "Request approval",
      approve: "Approve",
    },
  },
];

export const templateIds = templates.map((template) => template.id) as [
  string,
  ...string[],
];

const byId = new Map(templates.map((template) => [template.id, template]));

export function getTemplate(id: string | null | undefined) {
  return byId.get(id || "blank") || byId.get("blank")!;
}

export type FieldValue = string | number | string[];

/**
 * Keeps only fields the board's template defines, with values of the right
 * shape. `null` removes a field. Returns the merged object.
 */
export function mergeFields(
  templateId: string,
  current: Record<string, FieldValue> | null | undefined,
  patch: Record<string, unknown>,
) {
  const definitions = new Map(
    getTemplate(templateId).fields.map((field) => [field.key, field]),
  );
  const next: Record<string, FieldValue> = { ...(current || {}) };
  for (const [key, raw] of Object.entries(patch)) {
    const field = definitions.get(key);
    if (!field) continue;
    if (raw === null || raw === "" || (Array.isArray(raw) && !raw.length)) {
      delete next[key];
      continue;
    }
    const value = cleanValue(field, raw);
    if (value === undefined) continue;
    next[key] = value;
  }
  return next;
}

function cleanValue(
  field: TemplateField,
  raw: unknown,
): FieldValue | undefined {
  switch (field.type) {
    case "number": {
      const number = Number(raw);
      return Number.isFinite(number) ? number : undefined;
    }
    case "multiselect": {
      if (!Array.isArray(raw)) return undefined;
      const allowed = new Set(field.options);
      const values = raw.filter(
        (item): item is string => typeof item === "string" && allowed.has(item),
      );
      return values.length ? [...new Set(values)] : undefined;
    }
    case "select":
      return typeof raw === "string" && field.options?.includes(raw)
        ? raw
        : undefined;
    case "date":
      return typeof raw === "string" && !Number.isNaN(Date.parse(raw))
        ? raw.slice(0, 10)
        : undefined;
    case "url":
      return typeof raw === "string" && /^https?:\/\/\S+$/i.test(raw.trim())
        ? raw.trim().slice(0, 2000)
        : undefined;
    default:
      return typeof raw === "string"
        ? raw.slice(0, field.type === "longtext" ? 5000 : 300)
        : undefined;
  }
}

/** Client-visible fields, resolved to label/value pairs for the portal. */
export function clientFields(
  templateId: string,
  values: Record<string, FieldValue> | null | undefined,
) {
  if (!values) return [];
  return getTemplate(templateId)
    .fields.filter((field) => field.client && values[field.key] !== undefined)
    .map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      value: values[field.key],
    }));
}
