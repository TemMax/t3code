import { describe, expect, it } from "vite-plus/test";
import { gradeCase } from "./grade.ts";

const expected = { phase: "testing", keywords: ["test", "suite"] } as const;
const testing = (label: string) => ({ phase: "testing", label }) as const;
const debugging = (label: string) => ({ phase: "debugging", label }) as const;

describe("gradeCase", () => {
  it.each([
    ["every sample matches", [testing("test suite"), testing("running tests")], true],
    [
      "one phase miss in five samples",
      [...Array.from({ length: 4 }, () => testing("test suite")), debugging("test suite")],
      true,
    ],
    [
      "phase miss below 80%",
      [testing("test suite"), testing("test suite"), debugging("test suite")],
      false,
    ],
    ["label without a keyword", [testing("login flow"), testing("test suite")], false],
    ["keyword only inside a word", [testing("update deps"), testing("test suite")], false],
    ["label sanitizing would change", [testing("Test Suite"), testing("test suite")], false],
    ["label over three words", [testing("full test suite run"), testing("test suite")], false],
    ["no samples", [], false],
  ] as const)("%s", (_name, answers, pass) => {
    expect(gradeCase(expected, answers).pass).toBe(pass);
  });

  it("accepts any phase and label when the case only needs a valid answer", () => {
    expect(
      gradeCase({ phase: null, keywords: [] }, [debugging("anything"), testing("else")]).pass,
    ).toBe(true);
  });
});
