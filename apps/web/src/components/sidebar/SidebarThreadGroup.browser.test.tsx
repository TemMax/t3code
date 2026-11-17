import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarThreadGroup, SidebarThreadGroupOverflowRow } from "./SidebarThreadGroup";

const rows = ["one", "two", "three"].map((name) => (
  <div key={name} className="h-8">
    <span data-thread-group-anchor>{name}</span>
  </div>
));

it("draws one branch per anchor", async () => {
  await using screen = await render(
    <SidebarThreadGroup expanded trunkX={10} branchEndX={30} trunkTopOffset={12}>
      {rows}
    </SidebarThreadGroup>,
  );
  await expect
    .poll(() => screen.container.querySelector("svg path")?.getAttribute("d")?.match(/H/g)?.length)
    .toBe(3);
  expect(screen.container.querySelectorAll("svg")).toHaveLength(1);
});

it("collapsed group hides workers", async () => {
  await using screen = await render(
    <SidebarThreadGroup expanded={false} trunkX={10} branchEndX={30} trunkTopOffset={12}>
      {rows}
    </SidebarThreadGroup>,
  );
  await expect.element(screen.getByText("one")).not.toBeInTheDocument();
});

it("overflow row shows its count and expands on click", async () => {
  const onExpand = vi.fn();
  await using screen = await render(
    <SidebarThreadGroupOverflowRow kind="settled" count={4} onExpand={onExpand} />,
  );
  await screen.getByText("+4 settled").click();
  expect(onExpand).toHaveBeenCalledTimes(1);
});
