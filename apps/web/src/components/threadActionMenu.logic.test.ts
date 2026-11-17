import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  threadGroupArchiveConfirmDetail,
  threadGroupDeleteConfirmDetail,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isPinnedInProject: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "pin-project",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "pin-project",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("offers the other pin scope beside unpin", () => {
    const pinIds = (state: Partial<ThreadActionMenuState>) =>
      buildThreadActionMenuItems({ ...baseState, ...state })
        .map((item) => item.id)
        .filter((id) => id.includes("pin"));
    expect(pinIds({})).toEqual(["pin", "pin-project"]);
    expect(pinIds({ isPinned: true })).toEqual(["unpin", "pin-project"]);
    expect(pinIds({ isPinned: true, isPinnedInProject: true })).toEqual(["unpin", "pin"]);
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("worker menu has detach and no pin", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      group: { role: "worker", attachCandidates: [{ key: "a", title: "Parent" }] },
    });
    const ids = items.map((item) => item.id);
    expect(ids).not.toContain("pin");
    expect(ids).not.toContain("pin-project");
    expect(ids).not.toContain("unpin");
    expect(ids).not.toContain("attach-to-thread");
    expect(ids.indexOf("detach-from-group")).toBe(ids.indexOf("settle") - 1);
    expect(items.find((item) => item.id === "detach-from-group")?.label).toBe("Detach from group");
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        isPinned: true,
        group: { role: "worker", attachCandidates: [] },
      })
        .map((item) => item.id)
        .filter((id) => id.includes("pin")),
    ).toEqual([]);
  });

  it("parent menu offers settle group with only-finished", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      group: { role: "parent", attachCandidates: [] },
    });
    const settle = items.find((item) => item.id === "settle");
    expect(settle?.label).toBe("Settle group");
    expect(settle?.children?.map((child) => [child.id, child.label])).toEqual([
      ["settle", "Whole group"],
      ["settle-finished", "Only finished threads"],
    ]);
    const snooze = items.find((item) => item.id === "snooze");
    expect(snooze?.label).toBe("Snooze group");
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour", "snooze:custom"]);
  });

  it("attach submenu lists candidates", () => {
    const candidates = [
      { key: "env:one", title: "First", detail: "main" },
      { key: "env:two", title: "Second" },
    ];
    for (const role of ["none", "parent"] as const) {
      const items = buildThreadActionMenuItems({
        ...baseState,
        group: { role, attachCandidates: candidates },
      });
      const ids = items.map((item) => item.id);
      expect(ids.indexOf("attach-to-thread")).toBe(ids.indexOf("pin-project") + 1);
      const attach = items.find((item) => item.id === "attach-to-thread");
      expect(attach?.label).toBe("Attach to thread");
      expect(attach?.children).toEqual([
        { id: "attach-to-thread:env:one", label: "First", detail: "main" },
        { id: "attach-to-thread:env:two", label: "Second" },
      ]);
    }
    const ids = buildThreadActionMenuItems(baseState).map((item) => item.id);
    expect(ids).not.toContain("attach-to-thread");
  });

  it("words the group archive and delete details by count", () => {
    expect(threadGroupArchiveConfirmDetail(1)).toBe(
      "Its 1 group thread will show on its own until you unarchive it.",
    );
    expect(threadGroupArchiveConfirmDetail(3)).toBe(
      "Its 3 group threads will show on their own until you unarchive it.",
    );
    expect(threadGroupDeleteConfirmDetail(1)).toBe(
      "Its 1 group thread will stay as a regular thread.",
    );
    expect(threadGroupDeleteConfirmDetail(2)).toBe(
      "Its 2 group threads will stay as regular threads.",
    );
  });
});
