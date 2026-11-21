// solve.js — Fast drop-in replacement for make.fun `csv-reader 1.0.0`.
//
// Pure JS (Node 22), no WASM / native addons / prebuilt binaries.
// Semantics are IDENTICAL to the reference (see oracle.js for the literal
// spec implementation this was fuzz-verified against).
//
// Design: a single left-to-right pass over the string with two tiers.
//  - Fast path: the positions of the next CR and the next `"` are tracked
//    incrementally (each indexOf scan resumes where the last stopped, so
//    total scanning stays linear). A record whose raw line contains no CR
//    and no quote is cut out with one native slice + split(',').
//  - General path: any record containing a CR or a quote is parsed by a
//    char-code transducer: unquoted fields are located by scanning for
//    the next delimiter and sliced whole; quoted fields jump quote-to-
//    quote with indexOf; segment-building slow paths run only when a
//    stray CR, quote junk or an unterminated quote actually occurs.
// Errors are allocated only when they occur. No state is kept between
// run() calls.

const COMMA = 44;
const QUOTE = 34;
const LF = 10;
const CR = 13;

// end kinds
const E_COMMA = 0;
const E_BREAK = 1;
const E_EOF = 2;

export function run(input) {
  const s = input && typeof input.text === "string" ? input.text : "";
  const header = !!(input && input.header);
  const n = s.length;

  let i = n > 0 && s.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  const records = []; // string[][]
  const errors = [];

  // Incremental trackers: first CR / first quote at or after the last
  // position they were computed for (Infinity when none remain).
  let nextCR = s.indexOf("\r", i);
  if (nextCR === -1) nextCR = Infinity;
  let nextQ = s.indexOf('"', i);
  if (nextQ === -1) nextQ = Infinity;

  let width = -1; // field count of the first record, once known
  const hasCR = nextCR !== Infinity; // no CR anywhere => hotter scans below
  const hasLF = s.indexOf("\n", i) !== -1;

  while (i < n) {
    // Locate the raw line [i, lineEnd) and its content end (CRLF stripped).
    const lf = s.indexOf("\n", i);
    const lineEnd = lf === -1 ? n : lf;
    let contentEnd = lineEnd;
    if (lf !== -1 && contentEnd > i && s.charCodeAt(contentEnd - 1) === CR) {
      contentEnd--;
    }
    if (contentEnd === i) {
      // Empty line (bare LF, or CRLF): not a record.
      i = lf === -1 ? n : lf + 1;
      if (lf !== -1) line++;
      continue;
    }
    if (nextCR < i) {
      const p = s.indexOf("\r", i);
      nextCR = p === -1 ? Infinity : p;
    }
    if (nextQ < i) {
      const p = s.indexOf('"', i);
      nextQ = p === -1 ? Infinity : p;
    }

    const recLine = line;
    const ord = records.length;
    const rowIdx = header ? (ord === 0 ? null : ord - 1) : ord;

    if (nextCR >= contentEnd && nextQ >= lineEnd) {
      // ---- FAST PATH: plain line, no CR, no quote ----
      const fields = s.slice(i, contentEnd).split(",");
      i = lf === -1 ? n : lf + 1;
      if (lf !== -1) line++;
      records.push(fields);
      if (width === -1) {
        width = fields.length;
      } else if (fields.length < width) {
        errors.push({
          code: "short_row",
          line: recLine,
          row: rowIdx,
          fields: fields.length,
        });
        fields.push(...new Array(width - fields.length).fill(""));
      } else if (fields.length > width) {
        errors.push({
          code: "long_row",
          line: recLine,
          row: rowIdx,
          extra: fields.length - width,
        });
        fields.length = width;
      }
      continue;
    }

    // ---- GENERAL PATH: record contains a CR or a quote ----
    const fields = [];
    let anyStarted = false;
    for (;;) {
      let value;
      let started;
      let end;

      if (i < n && s.charCodeAt(i) === QUOTE) {
        const r = quotedField(s, i, line, errors, recLine, rowIdx);
        value = r[0];
        i = r[1];
        line = r[2];
        end = r[3];
        started = r[4];
      } else {
        // Unquoted field: jump to the nearest delimiter with native
        // searches. Comma and LF are dense in CSV data; the CR position
        // comes from the incremental tracker, so no search is unbounded.
        let endPos = -1;
        let kind = E_EOF;
        const jc = s.indexOf(",", i);
        if (jc !== -1) {
          endPos = jc;
          kind = E_COMMA;
        }
        if (hasLF) {
          const jl = s.indexOf("\n", i);
          if (jl !== -1 && (endPos === -1 || jl < endPos)) {
            endPos = jl;
            kind = E_BREAK;
          }
        }
        if (hasCR) {
          if (nextCR < i) {
            const p = s.indexOf("\r", i);
            nextCR = p === -1 ? Infinity : p;
          }
          if (nextCR !== Infinity && (endPos === -1 || nextCR < endPos)) {
            endPos = nextCR;
            kind = 3; // CR: CRLF break or stray CR
          }
        }
        if (kind === E_EOF) {
          value = s.slice(i, n);
          started = n > i;
          i = n;
          end = E_EOF;
        } else if (kind === E_COMMA) {
          value = s.slice(i, endPos);
          started = endPos > i;
          i = endPos + 1;
          end = E_COMMA;
        } else if (kind === E_BREAK) {
          value = s.slice(i, endPos);
          started = endPos > i;
          i = endPos + 1;
          line++;
          end = E_BREAK;
        } else if (s.charCodeAt(endPos + 1) === LF) {
          // CRLF record break
          value = s.slice(i, endPos);
          started = endPos > i;
          i = endPos + 2;
          line++;
          end = E_BREAK;
        } else {
          // Stray CR inside the field: rebuild it on the slow path.
          const r = unquotedSlow(s, i, line, errors, recLine, rowIdx);
          value = r[0];
          i = r[1];
          line = r[2];
          end = r[3];
          started = r[4];
        }
      }

      fields.push(value);
      if (started) anyStarted = true;
      if (end !== E_COMMA) break;
    }

    if (fields.length > 1 || anyStarted) {
      records.push(fields);
      if (width === -1) {
        width = fields.length;
      } else if (fields.length < width) {
        errors.push({
          code: "short_row",
          line: recLine,
          row: rowIdx,
          fields: fields.length,
        });
      } else if (fields.length > width) {
        errors.push({
          code: "long_row",
          line: recLine,
          row: rowIdx,
          extra: fields.length - width,
        });
      }
    }
  }

  // ---- assembly: width of the first record governs rows ----
  let columns = null;
  const rows = [];
  if (records.length > 0) {
    let start = 0;
    if (header) {
      columns = records[0];
      start = 1;
    }
    for (let k = start; k < records.length; k++) {
      let f = records[k];
      if (f.length < width) {
        f = f.concat(new Array(width - f.length).fill(""));
      } else if (f.length > width) {
        f = f.slice(0, width);
      }
      rows.push(f);
    }
  }

  return { columns, rows, errors };
}

// Slow path: unquoted field containing at least one stray CR.
// Also used for the unquoted re-read after an unterminated quote
// (a `"` encountered here is literal, exactly as the spec requires).
// Returns [value, i, line, end, started].
function unquotedSlow(s, i, line, errors, recLine, rowIdx) {
  const n = s.length;
  let val = "";
  let started = false;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === COMMA) return [val, j + 1, line, E_COMMA, started];
    if (c === LF) return [val, j + 1, line + 1, E_BREAK, started];
    if (c === CR) {
      if (s.charCodeAt(j + 1) === LF) return [val, j + 2, line + 1, E_BREAK, started];
      errors.push({ code: "stray_cr", line: recLine, row: rowIdx });
      j++;
      continue;
    }
    val += s[j];
    started = true;
    j++;
  }
  return [val, n, line, E_EOF, started];
}

// Quoted field (s[i] is the opening quote), including the junk phase after
// the closing quote. Returns [value, i, line, end, started].
function quotedField(s, i, line, errors, recLine, rowIdx) {
  const n = s.length;
  const lineSave = line;
  let j = i + 1;
  let val = "";

  // Scan to the closing quote, jumping quote-to-quote.
  for (;;) {
    if (j >= n) {
      errors.push({ code: "unterminated_quote", line: recLine, row: rowIdx });
      return unquotedSlow(s, i, lineSave, errors, recLine, rowIdx);
    }
    const q = s.indexOf('"', j);
    if (q === -1) {
      errors.push({ code: "unterminated_quote", line: recLine, row: rowIdx });
      return unquotedSlow(s, i, lineSave, errors, recLine, rowIdx);
    }
    // Segment [j, q): check for CR/LF with a scan BOUNDED to the segment
    // (an unbounded indexOf from j would scan to end-of-string per field).
    let hasBreak = false;
    for (let k = j; k < q; k++) {
      const cc = s.charCodeAt(k);
      if (cc === CR || cc === LF) {
        hasBreak = true;
        break;
      }
    }
    if (hasBreak) {
      let k = j;
      while (k < q) {
        const c = s.charCodeAt(k);
        if (c === CR) {
          // A CR at q-1 is followed by the quote, not LF: still one break.
          if (k + 1 < q && s.charCodeAt(k + 1) === LF) k++;
          val += "\n";
          line++;
          k++;
        } else if (c === LF) {
          val += "\n";
          line++;
          k++;
        } else {
          val += s[k];
          k++;
        }
      }
    } else if (q > j) {
      val += s.slice(j, q);
    }
    // s[q] is a quote: doubled => literal, otherwise the closing quote.
    if (s.charCodeAt(q + 1) === QUOTE) {
      val += '"';
      j = q + 2;
      continue;
    }
    j = q + 1; // consume closing quote
    break;
  }

  // Junk phase: append everything up to the next comma / break / EOF.
  let appended = false;
  for (;;) {
    let k = j;
    let stray = false;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === COMMA || c === LF) break;
      if (c === CR) {
        if (s.charCodeAt(k + 1) === LF) break;
        stray = true;
        break;
      }
      k++;
    }
    if (k > j) {
      val += s.slice(j, k);
      appended = true;
      j = k;
    }
    if (stray) {
      errors.push({ code: "stray_cr", line: recLine, row: rowIdx });
      j++; // drop the stray CR, keep scanning junk
      continue;
    }
    if (appended) errors.push({ code: "quote_junk", line: recLine, row: rowIdx });
    if (j >= n) return [val, n, line, E_EOF, true];
    const c = s.charCodeAt(j);
    if (c === COMMA) return [val, j + 1, line, E_COMMA, true];
    if (c === LF) return [val, j + 1, line + 1, E_BREAK, true];
    return [val, j + 2, line + 1, E_BREAK, true]; // CRLF
  }
}
