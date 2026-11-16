import { describe, expect, test } from "bun:test";
import { isSlackWebhook, slackEscape, slackMessage } from "./slack";

describe("slack", () => {
  test("only accepts Slack webhook URLs", () => {
    expect(isSlackWebhook("https://hooks.slack.com/services/T0/B0/xyz")).toBe(
      true,
    );
    expect(isSlackWebhook("http://hooks.slack.com/services/T0/B0/xyz")).toBe(
      false,
    );
    expect(isSlackWebhook("https://hooks.slack.com.evil.io/services/x")).toBe(
      false,
    );
    expect(
      isSlackWebhook("https://evil.io/?u=https://hooks.slack.com/services/"),
    ).toBe(false);
    expect(isSlackWebhook("https://hooks.slack.com/other")).toBe(false);
    expect(isSlackWebhook("not a url")).toBe(false);
  });

  test("escapes user text so it can't inject links or mentions", () => {
    expect(slackEscape("<!channel> & <https://x|y>")).toBe(
      "&lt;!channel&gt; &amp; &lt;https://x|y&gt;",
    );
    const message = slackMessage({
      boardId: "b1",
      boardName: "Acme <site>",
      event: "client",
      actor: "Lena <!here>",
      verb: "approved",
      cardId: "c1",
      cardTitle: "Logo > v2",
      quote: "Looks great\nship it",
    });
    const text = JSON.stringify(message.blocks);
    expect(text).not.toContain("<!here>");
    expect(message.text).not.toContain("<!here>");
    expect(text).toContain("Lena &lt;!here&gt;");
    expect(text).toContain("/boards/b1?card=c1|Logo &gt; v2>");
    expect(text).toContain(">Looks great\\n>ship it");
    expect(text).toContain("Acme &lt;site&gt;");
  });
});
