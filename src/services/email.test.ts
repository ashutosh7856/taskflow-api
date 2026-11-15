import { describe, expect, test } from "bun:test";

import { renderEmail } from "./email";

describe("email template", () => {
  test("renders OTP code, details, button and escapes user content", () => {
    const html = renderEmail({
      to: "a@b.co",
      subject: "Code",
      title: "Reset <your> password",
      message: "Line one\n\nLine two",
      code: "123456",
      details: [["Board", "<script>x</script>"]],
      actionLabel: "Enter code",
      actionUrl: "https://danto.app/forgot-password?email=a%40b.co",
    });
    expect(html).toContain("123456");
    expect(html).toContain("Reset &lt;your&gt; password");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("Enter code");
    expect(html.match(/<p /g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("client-facing brand replaces Danto logo and colors the button", () => {
    const html = renderEmail({
      to: "c@d.co",
      subject: "Approve",
      title: "Homepage",
      message: "Ready",
      actionLabel: "Review",
      actionUrl: "https://danto.app/p/x",
      brand: { name: "Northwind", color: "#5b3df5" },
      showCredit: false,
    });
    expect(html).toContain("Northwind");
    expect(html).toContain("background:#5b3df5");
    expect(html).not.toContain("Sent with Danto");
  });
});
