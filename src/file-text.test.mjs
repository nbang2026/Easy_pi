import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFileText, preserveFileLineEndings } from "./file-text.ts";

test("native text normalizes to the textarea value without losing its separators on a no-op", () => {
  const native="first\r\nsecond\nthird\rfourth\r\n";
  const value="first\nsecond\nthird\nfourth\n";
  assert.equal(normalizeFileText(native),value);
  assert.equal(preserveFileLineEndings(native,value),native);
});

test("deleting and replacing mixed-ending lines preserves the untouched suffix", () => {
  const native="first\r\nsecond\nthird\rfourth\r\n";
  assert.equal(preserveFileLineEndings(native,"first\nthird\nfourth\n"),"first\r\nthird\rfourth\r\n");
  assert.equal(preserveFileLineEndings(native,"FIRST\nSECOND\nthird\nfourth\n"),"FIRST\r\nSECOND\nthird\rfourth\r\n");
});

test("new lines use the prevalent native ending and empty files use LF", () => {
  assert.equal(preserveFileLineEndings("first\r\nsecond\r\nthird\n","first\r\nsecond\r\ninserted\r\nthird\n"),"first\r\nsecond\r\ninserted\r\nthird\n");
  assert.equal(preserveFileLineEndings("","first\nsecond\n"),"first\nsecond\n");
  assert.equal(preserveFileLineEndings("one\r\ntwo\r\n",""),"");
});

test("successive edits retain local mixed endings and always match the visible textarea text", () => {
  let native="one\r\ntwo\nthree\rfour\r\n";
  for(const value of ["ONE\ntwo\nthree\nfour\n","ONE\ninserted\ntwo\nthree\nfour\n","ONE\ninserted\ntwo\nTHREE\nfour\n"]){
    native=preserveFileLineEndings(native,value);
    assert.equal(normalizeFileText(native),value);
  }
  assert.equal(native,"ONE\r\ninserted\r\ntwo\nTHREE\rfour\r\n");
});
