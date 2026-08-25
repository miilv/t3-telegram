import { describe, expect, it } from "vitest";
import { isCancelIntent } from "../packages/router/src/index.js";

describe("isCancelIntent", () => {
  it("accepts short standalone cancel phrases", () => {
    for (const text of [
      "стоп",
      "Стоп!",
      "отмена",
      "Отмени",
      "хватит",
      "stop",
      "Stop it",
      "cancel",
      "стоп, пожалуйста",
    ]) {
      expect(isCancelIntent(text), text).toBe(true);
    }
  });

  it("rejects sentences that merely start with a cancel word (bug №1)", () => {
    for (const text of [
      "stop doing X when the tests pass",
      "стоп слово тут вообще не команда",
      "хватит ли нам бюджета на этот квартал?",
      "please stop",
      "останови работу",
      "",
      "   ",
    ]) {
      expect(isCancelIntent(text), text).toBe(false);
    }
  });
});
