import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchKeywords,
  normalizeKeyword,
  shouldAlert,
  validateKeyword,
} from "../src/matcher.ts";

test("normalizeKeyword case-folds Ukrainian І/і and collapses spaces", () => {
  assert.equal(normalizeKeyword("  Буча  "), "буча");
  assert.equal(normalizeKeyword("Ірпінь"), normalizeKeyword("ірпінь"));
  assert.equal(normalizeKeyword("Біла   Церква"), "біла церква");
});

test("validateKeyword enforces length and rejects newlines", () => {
  assert.equal(
    validateKeyword("Б"),
    "Ключ має бути від 2 до 64 символів, без розриву рядка.",
  );
  assert.equal(validateKeyword("Буча"), null);
  assert.equal(
    validateKeyword("a\nb"),
    "Ключ має бути від 2 до 64 символів, без розриву рядка.",
  );
});

test("matchKeywords is case-insensitive and catches Ukrainian endings", () => {
  const keys: Array<[string, string]> = [
    [normalizeKeyword("Буча"), "Буча"],
    [normalizeKeyword("ракета"), "ракета"],
  ];
  assert.deepEqual(matchKeywords("На Бучу зайшов борт", keys), ["Буча"]);
  assert.deepEqual(matchKeywords("буча, щось летить", keys), ["Буча"]);
  assert.deepEqual(matchKeywords("Бучі відбій", keys), ["Буча"]);
  assert.deepEqual(matchKeywords("Бучач під ударом", keys), ["Буча"]);
  assert.deepEqual(matchKeywords("ракета і Буча", keys), ["Буча", "ракета"]);
  assert.deepEqual(matchKeywords("Житомир тихо", keys), []);
});

test("Дарниця does not match Дарницький, but still matches Darnitsia cases", () => {
  const keys: Array<[string, string]> = [[normalizeKeyword("Дарниця"), "Дарниця"]];
  assert.deepEqual(matchKeywords("На Дарницький міст", keys), []);
  assert.deepEqual(matchKeywords("дарницька траса", keys), []);
  assert.deepEqual(matchKeywords("у Дарниці відбій", keys), ["Дарниця"]);
  assert.deepEqual(matchKeywords("На Дарницю", keys), ["Дарниця"]);
  assert.deepEqual(matchKeywords("Дарниця і Дарницький міст", keys), ["Дарниця"]);
});

test("Лісовий does not match Лісовичі", () => {
  const keys: Array<[string, string]> = [[normalizeKeyword("Лісовий"), "Лісовий"]];
  assert.deepEqual(matchKeywords("Лісовичі, борт", keys), []);
  assert.deepEqual(matchKeywords("на Лісовий", keys), ["Лісовий"]);
  assert.deepEqual(matchKeywords("Лісовий і Лісовичі", keys), ["Лісовий"]);
});

test("empty keyword list never matches", () => {
  assert.deepEqual(matchKeywords("Буча", []), []);
});

test("shouldAlert dedups and allows new keywords on edit", () => {
  assert.equal(shouldAlert([], null), false);
  assert.equal(shouldAlert(["Буча"], null), true);
  assert.equal(shouldAlert(["Буча"], [normalizeKeyword("Буча")]), false);
  assert.equal(
    shouldAlert(["Буча", "ракета"], [normalizeKeyword("Буча")]),
    true,
  );
});
