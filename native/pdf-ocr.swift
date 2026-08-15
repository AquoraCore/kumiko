// Apple Vision OCR helper for Kumiko (desktop/macOS only). Renders each PDF page with
// PDFKit and runs on-device VNRecognizeTextRequest (Thai + English). Prints markdown text.
// Build: swiftc -O native/pdf-ocr.swift -o native/pdf-ocr   (bundled into Kumiko.app)
// Usage: pdf-ocr <pdf-path> [maxPages]
import Foundation
import Vision
import PDFKit
import CoreGraphics

let args = CommandLine.arguments
guard args.count > 1, let pdf = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
  FileHandle.standardError.write("ERR: cannot open pdf\n".data(using: .utf8)!); exit(1)
}
let maxPages = args.count > 2 ? (Int(args[2]) ?? pdf.pageCount) : pdf.pageCount
let scale: CGFloat = 2.0   // ~144dpi for OCR quality
var out = ""
for i in 0..<min(maxPages, pdf.pageCount) {
  guard let page = pdf.page(at: i) else { continue }
  let rect = page.bounds(for: .mediaBox)
  let w = Int(rect.width * scale), h = Int(rect.height * scale)
  guard w > 0, h > 0,
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue) else { continue }
  ctx.setFillColor(CGColor(gray: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx)
  guard let cg = ctx.makeImage() else { continue }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  req.recognitionLanguages = ["th-TH", "en-US"]
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  try? handler.perform([req])
  var pageText = ""
  for o in (req.results ?? []) { if let c = o.topCandidates(1).first { pageText += c.string + "\n" } }
  out += "## หน้า \(i + 1)\n\n" + pageText + "\n"
}
print(out)
