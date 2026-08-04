// Aquasafe — minimal PDF 1.4 writer.
//
// Why hand-rolled: the field apps are asset-free and must render a report with the
// phone offline and no CDN reachable, so pulling in jsPDF (~350 kB) is not an option.
// We only need one page, two standard fonts (no embedding — Helvetica is one of the 14
// base fonts every reader ships) and one JPEG, which is a small enough slice of the
// spec to write directly.
//
// Everything is assembled as a latin1 string so 1 char == 1 byte and the xref byte
// offsets are just string lengths. Nothing may enter the buffer above code point 255.
var AquasafePDF = (function () {
  var PT_W = 595.28, PT_H = 841.89;               // A4 portrait

  // ---- text encoding -------------------------------------------------------
  // The page is WinAnsi. The app's UI legitimately contains characters outside it
  // (subscript ten in the formula, the multiplication sign, en dashes), so fold them
  // to ASCII rather than emitting bytes the reader would render as garbage.
  var FOLD = {
    '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-',
    '‘': "'", '’': "'", '“': '"', '”': '"',
    '…': '...', '×': 'x', '→': '->', '≤': '<=', '≥': '>=',
    '√': 'sqrt', '₀': '0', '₁': '1', '₂': '2', '₃': '3',
    '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8',
    '₉': '9', '²': '2', '³': '3', '⁰': '0',
    '✓': 'OK', '⚠': '!', '·': '-'
  };
  function winAnsi(s) {
    var out = '', i, c, cp;
    s = String(s == null ? '' : s);
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i); cp = s.charCodeAt(i);
      if (FOLD[c]) { out += FOLD[c]; continue; }
      if (cp === 10 || cp === 13) { out += ' '; continue; }
      // Latin-1 maps 1:1 onto WinAnsi over these ranges; anything else is dropped
      // rather than guessed at (a mangled glyph in a field record is worse than a gap).
      if (cp >= 32 && cp <= 126) out += c;
      else if (cp >= 160 && cp <= 255) out += c;
      else out += '?';
    }
    return out;
  }
  function esc(s) { return winAnsi(s).replace(/([\\()])/g, '\\$1'); }

  // ---- Helvetica advance widths (AFM /1000 em) ------------------------------
  // Needed for wrapping and right-alignment; the reader has the font but we do not,
  // so measurement has to happen here.
  var W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  var W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
  function charWidth(cp, bold) {
    var t = bold ? W_BOLD : W_REG;
    if (cp >= 32 && cp <= 126) return t[cp - 32];
    if (cp === 176) return bold ? 400 : 400;       // degree
    if (cp >= 160 && cp <= 255) return bold ? 556 : 500;   // good-enough default
    return bold ? 556 : 500;
  }
  function textWidth(s, size, bold) {
    s = winAnsi(s);
    var w = 0, i;
    for (i = 0; i < s.length; i++) w += charWidth(s.charCodeAt(i), bold);
    return w * size / 1000;
  }
  function wrap(s, size, bold, maxW) {
    var words = winAnsi(s).split(/\s+/).filter(Boolean), lines = [], cur = '';
    words.forEach(function (word) {
      var trial = cur ? cur + ' ' + word : word;
      if (textWidth(trial, size, bold) <= maxW) { cur = trial; return; }
      if (cur) lines.push(cur);
      // A single word longer than the column would loop forever below if not split.
      while (textWidth(word, size, bold) > maxW && word.length > 1) {
        var n = 1;
        while (n < word.length && textWidth(word.slice(0, n + 1), size, bold) <= maxW) n++;
        lines.push(word.slice(0, n)); word = word.slice(n);
      }
      cur = word;
    });
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  // ---- JPEG parsing --------------------------------------------------------
  // The image is embedded raw with /DCTDecode, so the PDF needs the dimensions and
  // component count from the SOF marker rather than re-encoding the pixels.
  function jpegInfo(bin) {
    var i = 2;
    while (i < bin.length) {
      if (bin.charCodeAt(i) !== 0xFF) { i++; continue; }
      var m = bin.charCodeAt(i + 1);
      // SOF0..SOF15, excluding DHT(C4), JPG(C8) and DAC(CC), carry the frame header
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return {
          h: (bin.charCodeAt(i + 5) << 8) | bin.charCodeAt(i + 6),
          w: (bin.charCodeAt(i + 7) << 8) | bin.charCodeAt(i + 8),
          comps: bin.charCodeAt(i + 9)
        };
      }
      var len = (bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3);
      if (!(len > 0)) break;
      i += 2 + len;
    }
    return null;
  }
  function dataURLtoBinary(u) {
    var b64 = String(u).split(',')[1] || '';
    try { return atob(b64); } catch (e) { return null; }
  }

  // ---- content-stream drawing ---------------------------------------------
  // Multi-page. The report has to carry BOTH the caveats and the photographic evidence,
  // and an OTO report's caveats alone can fill a page — so running out of room breaks to
  // a new page instead of silently dropping whatever came last. An earlier one-page
  // version quietly omitted the photo from every OTO report, which is exactly the kind
  // of failure a field record must not have.
  function Canvas() { this.pages = [[]]; this.cur = 0; }
  Canvas.prototype.op = function (s) { this.pages[this.cur].push(s); };
  Canvas.prototype.rect = function (x, y, w, h, rgb) {
    this.op(rgb[0] + ' ' + rgb[1] + ' ' + rgb[2] + ' rg');
    this.op(f(x) + ' ' + f(y) + ' ' + f(w) + ' ' + f(h) + ' re f');
  };
  Canvas.prototype.line = function (x1, y1, x2, y2, rgb, lw) {
    this.op(rgb[0] + ' ' + rgb[1] + ' ' + rgb[2] + ' RG');
    this.op(f(lw || 0.6) + ' w');
    this.op(f(x1) + ' ' + f(y1) + ' m ' + f(x2) + ' ' + f(y2) + ' l S');
  };
  Canvas.prototype.text = function (x, y, s, size, bold, rgb) {
    rgb = rgb || [0, 0, 0];
    this.op('BT ' + rgb[0] + ' ' + rgb[1] + ' ' + rgb[2] + ' rg /' + (bold ? 'F2' : 'F1') +
      ' ' + f(size) + ' Tf 1 0 0 1 ' + f(x) + ' ' + f(y) + ' Tm (' + esc(s) + ') Tj ET');
  };
  Canvas.prototype.textRight = function (xr, y, s, size, bold, rgb) {
    this.text(xr - textWidth(s, size, bold), y, s, size, bold, rgb);
  };
  Canvas.prototype.image = function (x, y, w, h) {
    this.op('q ' + f(w) + ' 0 0 ' + f(h) + ' ' + f(x) + ' ' + f(y) + ' cm /Im1 Do Q');
  };
  Canvas.prototype.breakPage = function () { this.pages.push([]); this.cur = this.pages.length - 1; };
  function f(n) { return (Math.round(n * 100) / 100).toString(); }

  // ---- document assembly ---------------------------------------------------
  function build(doc) {
    var cv = new Canvas();
    var M = 42, colR = PT_W - M, y;
    var TEAL = [0.008, 0.36, 0.45], INK = [0.07, 0.2, 0.23], GREY = [0.38, 0.42, 0.45];

    // header band
    cv.rect(0, PT_H - 92, PT_W, 92, TEAL);
    cv.text(M, PT_H - 46, doc.appName || 'Aquasafe', 22, true, [1, 1, 1]);
    cv.text(M, PT_H - 66, doc.title || 'Chlorine Field Test Report', 11.5, false, [0.82, 0.94, 0.97]);
    cv.textRight(colR, PT_H - 46, doc.reagent || '', 13, true, [1, 1, 1]);
    cv.textRight(colR, PT_H - 66, doc.stamp || '', 9.5, false, [0.82, 0.94, 0.97]);
    y = PT_H - 128;

    // Reserve room for content, breaking to a fresh page when the block will not fit.
    // Everything below goes through this rather than clipping.
    function need(h) {
      if (y - h >= 72) return y;
      cv.breakPage();
      cv.rect(0, PT_H - 44, PT_W, 44, TEAL);
      cv.text(M, PT_H - 30, (doc.appName || 'Aquasafe') + ' — ' + (doc.title || 'report'), 11, true, [1, 1, 1]);
      cv.textRight(colR, PT_H - 30, (doc.reagent || '') + '  ·  ' + (doc.stamp || ''), 9, false, [0.82, 0.94, 0.97]);
      y = PT_H - 74;
      return y;
    }

    // headline result. The uncertainty range gets its own line rather than trailing the
    // value: appended inline it ran under the verdict chip on exactly the OTO reports
    // where the range is the point.
    var hasSub = !!doc.resultSub, boxH = hasSub ? 76 : 62;
    cv.rect(M, y - boxH, colR - M, boxH, [0.93, 0.97, 0.98]);
    cv.text(M + 14, y - 34, doc.resultLabel || '', 10, true, TEAL);
    cv.text(M + 14, y - 56, doc.resultValue || '', 26, true, INK);
    if (hasSub) cv.text(M + 14, y - 70, doc.resultSub, 9, true, [0.55, 0.27, 0]);
    if (doc.verdict) {
      var vw = textWidth(doc.verdict, 10, true) + 18;
      cv.rect(colR - 14 - vw, y - 40, vw, 20, doc.verdictRGB || [0.87, 0.96, 0.87]);
      cv.text(colR - 14 - vw + 9, y - 34, doc.verdict, 10, true, doc.verdictInk || [0.08, 0.41, 0.11]);
    }
    y -= boxH + 22;

    // field table — two columns of label/value pairs
    (doc.sections || []).forEach(function (sec) {
      y = need(40);
      cv.text(M, y, sec.heading, 11, true, TEAL);
      cv.line(M, y - 5, colR, y - 5, [0.81, 0.9, 0.93], 0.7);
      y -= 18;
      (sec.rows || []).forEach(function (row) {
        var vlines = wrap(row[1], 9.5, true, colR - M - 190);
        y = need(14 + (vlines.length - 1) * 12);
        cv.text(M + 4, y, row[0], 9.5, false, GREY);
        vlines.forEach(function (ln, i) {
          cv.text(M + 190, y - i * 12, ln, 9.5, true, INK);
        });
        y -= 14 + (vlines.length - 1) * 12;
      });
      y -= 10;
    });

    // free-form notes
    (doc.notes || []).forEach(function (n) {
      var lines = wrap(n.text, 9, n.bold, colR - M - 8);
      // Keep a heading with at least two lines of its own paragraph — a heading
      // stranded alone at the foot of a page reads as a missing section.
      y = need((n.heading ? 18 : 0) + Math.min(lines.length, 2) * 12);
      if (n.heading) { cv.text(M, y, n.heading, 11, true, TEAL); cv.line(M, y - 5, colR, y - 5, [0.81, 0.9, 0.93], 0.7); y -= 18; }
      lines.forEach(function (ln) { y = need(12); cv.text(M + 4, y, ln, 9, n.bold, n.rgb || INK); y -= 12; });
      y -= 8;
    });

    // photo — evidence, so it gets a page of its own rather than being dropped
    var imgBin = null, info = null;
    if (doc.imageDataURL) {
      imgBin = dataURLtoBinary(doc.imageDataURL);
      info = imgBin ? jpegInfo(imgBin) : null;
      if (info && info.w && info.h) {
        y = need(220);
        cv.text(M, y, 'Stamped capture', 11, true, TEAL);
        cv.line(M, y - 5, colR, y - 5, [0.81, 0.9, 0.93], 0.7);
        y -= 12;
        var scale = Math.min((colR - M) / info.w, (y - 76) / info.h, 1);
        var dw = info.w * scale, dh = info.h * scale;
        cv.image(M, y - dh, dw, dh);
        y -= dh + 12;
      } else { imgBin = null; }
    }

    // footer on every page
    var total = cv.pages.length;
    for (var p = 0; p < total; p++) {
      cv.cur = p;
      cv.line(M, 56, colR, 56, [0.81, 0.9, 0.93], 0.7);
      wrap(doc.footer || '', 7.5, false, colR - M - 60).slice(0, 4).forEach(function (ln, i) {
        cv.text(M, 44 - i * 9, ln, 7.5, false, GREY);
      });
      cv.textRight(colR, 44, 'Page ' + (p + 1) + ' of ' + total, 7.5, true, GREY);
    }

    return serialize(cv.pages, imgBin, info, doc);
  }

  function serialize(pageOps, imgBin, info, doc) {
    var objs = [];
    function add(s) { objs.push(s); return objs.length; }   // 1-based object numbers

    var nCatalog = add(null), nPages = add(null), nF1 = add(null), nF2 = add(null);
    var nImg = imgBin ? add(null) : 0;
    var pageNums = [], contentNums = [];
    pageOps.forEach(function () { pageNums.push(add(null)); contentNums.push(add(null)); });

    objs[nCatalog - 1] = '<< /Type /Catalog /Pages ' + nPages + ' 0 R >>';
    objs[nPages - 1] = '<< /Type /Pages /Kids [' +
      pageNums.map(function (p) { return p + ' 0 R'; }).join(' ') + '] /Count ' + pageNums.length + ' >>';
    pageOps.forEach(function (ops, i) {
      var content = ops.join('\n');
      objs[pageNums[i] - 1] = '<< /Type /Page /Parent ' + nPages + ' 0 R /MediaBox [0 0 ' +
        f(PT_W) + ' ' + f(PT_H) + '] /Resources << /Font << /F1 ' + nF1 + ' 0 R /F2 ' + nF2 +
        ' 0 R >>' + (nImg ? ' /XObject << /Im1 ' + nImg + ' 0 R >>' : '') +
        ' >> /Contents ' + contentNums[i] + ' 0 R >>';
      objs[contentNums[i] - 1] = '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream';
    });
    objs[nF1 - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objs[nF2 - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    if (nImg) {
      objs[nImg - 1] = '<< /Type /XObject /Subtype /Image /Width ' + info.w + ' /Height ' + info.h +
        ' /ColorSpace /Device' + (info.comps === 1 ? 'Gray' : 'RGB') +
        ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + imgBin.length +
        ' >>\nstream\n' + imgBin + '\nendstream';
    }

    var out = '%PDF-1.4\n%âãÏÓ\n';
    var offsets = [];
    objs.forEach(function (body, i) {
      offsets.push(out.length);
      out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
    });
    var xref = out.length;
    out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
    offsets.forEach(function (o) { out += ('0000000000' + o).slice(-10) + ' 00000 n \n'; });
    out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + nCatalog + ' 0 R' +
      ' /Info << /Title (' + esc(doc.title || 'Aquasafe report') + ')' +
      ' /Producer (Aquasafe) /Creator (Aquasafe) >> >>\nstartxref\n' + xref + '\n%%EOF';

    var bytes = new Uint8Array(out.length);
    for (var i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xFF;
    return new Blob([bytes], { type: 'application/pdf' });
  }

  return { build: build, _textWidth: textWidth, _wrap: wrap, _jpegInfo: jpegInfo, _winAnsi: winAnsi };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AquasafePDF;
