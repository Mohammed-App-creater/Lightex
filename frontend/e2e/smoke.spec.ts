import { expect, test, type Page } from "@playwright/test";

/* Smoke: sign in, move around the app, and prove permission-driven hiding for every default role. */

async function as(page: Page, userId: string) {
  await page.addInitScript((u) => {
    localStorage.setItem("lightex-mock-session", u);
    // Deterministic mock: no injected failures.
    localStorage.setItem("lightex-mock-controls", JSON.stringify({ errorRate: 0, teammates: false }));
  }, userId);
}

const projectTabs = (page: Page) => page.getByRole("navigation", { name: "Project views" });

test("sign in, open a board, a task and the palette", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("alex@team.dev");
  await page.getByLabel("Password", { exact: true }).fill("password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/platform$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Alex");

  await page.goto("/platform/projects/PRJ/board");
  await expect(page.getByRole("button", { name: /PRJ-42/ }).first()).toBeVisible();
  await page.getByRole("button", { name: /PRJ-42/ }).first().click();
  await expect(page).toHaveURL(/task=PRJ-42/);
  await expect(page.getByRole("heading", { name: "Fix flaky board reflow on column resize" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/task=/);

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible();
  await page.keyboard.type("PRJ-33");
  await expect(palette.getByRole("option", { name: /SSO login with Okta/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/task=PRJ-33/);
});

const matrix = [
  { who: "Owner + Project Admin", user: "u_alex", tabs: ["Sprints", "Reports", "Settings"], hidden: [], newTask: true, membersNav: true },
  { who: "Admin + Manager", user: "u_jordan", tabs: ["Sprints", "Reports", "Settings"], hidden: [], newTask: true, membersNav: true },
  { who: "Member + Member", user: "u_sam", tabs: ["Reports"], hidden: ["Settings"], newTask: true, membersNav: false },
  { who: "Viewer", user: "u_taylor", tabs: [], hidden: ["Sprints", "Reports", "Settings"], newTask: false, membersNav: false },
];

for (const r of matrix) {
  test(`role hiding: ${r.who}`, async ({ page }) => {
    await as(page, r.user);
    await page.goto("/platform/projects/PRJ/board");
    const tabs = projectTabs(page);
    await expect(tabs.getByRole("link", { name: "Board" })).toBeVisible();
    for (const t of r.tabs) await expect(tabs.getByRole("link", { name: t, exact: true })).toBeVisible();
    for (const t of r.hidden) await expect(tabs.getByRole("link", { name: t, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^New task/ })).toHaveCount(r.newTask ? 2 : 0);
    await expect(page.getByRole("link", { name: "Members & roles" })).toHaveCount(r.membersNav ? 1 : 0);
  });
}

test("role hiding: workspace Admin with no project membership gets 403 + request access", async ({ page }) => {
  await as(page, "u_casey");
  await page.goto("/platform/projects/PRJ/board");
  await expect(page.getByRole("heading", { name: "You’re not a member of this project" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request access" })).toBeVisible();
});

test("only the Owner sees Delete workspace", async ({ page }) => {
  await as(page, "u_jordan");
  await page.goto("/platform/settings/general");
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Delete workspace/ })).toHaveCount(0);
});

test("the Owner does see Delete workspace", async ({ page }) => {
  await as(page, "u_alex");
  await page.goto("/platform/settings/general");
  await expect(page.getByRole("button", { name: /Delete workspace/ })).toBeVisible();
});
