import SwiftUI
import UIKit

public enum MarkupToolKind: String, CaseIterable, Identifiable {
    case pen
    case arrow
    case box

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .pen: return "涂鸦"
        case .arrow: return "箭头"
        case .box: return "框选"
        }
    }

    public var icon: String {
        switch self {
        case .pen: return "pencil.tip"
        case .arrow: return "arrow.up.right"
        case .box: return "rectangle"
        }
    }
}

public struct MarkupStrokeItem: Identifiable {
    public let id = UUID()
    public var tool: MarkupToolKind
    public var colorHex: String
    /// Normalized points in `[0...1, 0...1]` relative to the displayed image rect!
    public var normalizedPoints: [CGPoint]

    public var swiftUIColor: Color {
        switch colorHex {
        case "amber": return VeloTheme.amber
        case "violet": return VeloTheme.accentViolet
        default: return Color(red: 0.96, green: 0.26, blue: 0.26)
        }
    }

    public var uiColor: UIColor {
        switch colorHex {
        case "amber": return UIColor(red: 0.984, green: 0.749, blue: 0.141, alpha: 1.0)
        case "violet": return UIColor(red: 0.545, green: 0.361, blue: 0.965, alpha: 1.0)
        default: return UIColor(red: 0.96, green: 0.26, blue: 0.26, alpha: 1.0)
        }
    }
}

public struct VeloImageAnnotatorSheet: View {
    public let originalImage: UIImage
    public let onCommit: (Data, UIImage) -> Void
    public let onCancel: () -> Void

    @State private var selectedTool: MarkupToolKind = .box
    @State private var selectedColorKey: String = "red"
    @State private var strokes: [MarkupStrokeItem] = []
    @State private var activeStroke: MarkupStrokeItem? = nil

    public init(
        originalImage: UIImage,
        onCommit: @escaping (Data, UIImage) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.originalImage = originalImage
        self.onCommit = onCommit
        self.onCancel = onCancel
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Interactive Image + Vector Markup Canvas
                GeometryReader { geo in
                    let fittedRect = aspectFitRect(imageSize: originalImage.size, in: geo.size)

                    ZStack {
                        Color.black.ignoresSafeArea()

                        Image(uiImage: originalImage)
                            .resizable()
                            .scaledToFit()
                            .frame(width: fittedRect.width, height: fittedRect.height)
                            .position(x: fittedRect.midX, y: fittedRect.midY)

                        Canvas { ctx, _ in
                            for s in strokes {
                                drawStroke(s, in: fittedRect, context: &ctx)
                            }
                            if let cur = activeStroke {
                                drawStroke(cur, in: fittedRect, context: &ctx)
                            }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 1)
                                .onChanged { val in
                                    let norm = normalize(point: val.location, in: fittedRect)
                                    if activeStroke == nil {
                                        let startNorm = normalize(point: val.startLocation, in: fittedRect)
                                        activeStroke = MarkupStrokeItem(
                                            tool: selectedTool,
                                            colorHex: selectedColorKey,
                                            normalizedPoints: [startNorm, norm]
                                        )
                                    } else {
                                        if selectedTool == .pen {
                                            activeStroke?.normalizedPoints.append(norm)
                                        } else {
                                            if var pts = activeStroke?.normalizedPoints, !pts.isEmpty {
                                                pts = [pts[0], norm]
                                                activeStroke?.normalizedPoints = pts
                                            }
                                        }
                                    }
                                }
                                .onEnded { _ in
                                    if let cur = activeStroke, cur.normalizedPoints.count >= 2 {
                                        strokes.append(cur)
                                    }
                                    activeStroke = nil
                                }
                        )
                    }
                }

                // Bottom Annotation Toolbar (Tools + Colors + Undo/Clear)
                VStack(spacing: 12) {
                    HStack(spacing: 10) {
                        // Tool Selector
                        HStack(spacing: 4) {
                            ForEach(MarkupToolKind.allCases) { tool in
                                Button {
                                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                    selectedTool = tool
                                } label: {
                                    HStack(spacing: 4) {
                                        Image(systemName: tool.icon)
                                            .font(.system(size: 13, weight: .semibold))
                                        Text(tool.label)
                                            .font(.system(size: 12, weight: .semibold))
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 7)
                                    .background(
                                        Capsule()
                                            .fill(selectedTool == tool ? Color.white.opacity(0.20) : Color.clear)
                                    )
                                    .foregroundStyle(selectedTool == tool ? .white : .white.opacity(0.65))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(3)
                        .background(Capsule().fill(Color.white.opacity(0.08)))

                        Spacer()

                        // Color Dots
                        HStack(spacing: 10) {
                            colorButton("red", color: Color(red: 0.96, green: 0.26, blue: 0.26))
                            colorButton("amber", color: VeloTheme.amber)
                            colorButton("violet", color: VeloTheme.accentViolet)
                        }

                        Spacer()

                        // Undo & Clear
                        HStack(spacing: 8) {
                            Button {
                                _ = strokes.popLast()
                            } label: {
                                Image(systemName: "arrow.uturn.backward")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(strokes.isEmpty ? .white.opacity(0.3) : .white)
                                    .frame(width: 34, height: 34)
                                    .background(Circle().fill(Color.white.opacity(0.10)))
                            }
                            .disabled(strokes.isEmpty)

                            Button {
                                strokes.removeAll()
                            } label: {
                                Image(systemName: "trash")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(strokes.isEmpty ? .white.opacity(0.3) : VeloTheme.coral)
                                    .frame(width: 34, height: 34)
                                    .background(Circle().fill(Color.white.opacity(0.10)))
                            }
                            .disabled(strokes.isEmpty)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(Color(red: 0.08, green: 0.085, blue: 0.11))
            }
            .navigationTitle("圈选标注截图")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(Color(red: 0.08, green: 0.085, blue: 0.11), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        onCancel()
                    }
                    .foregroundStyle(.white.opacity(0.8))
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成标注") {
                        let rendered = renderFlattenedImage()
                        if let jpeg = rendered.jpegData(compressionQuality: 0.88) {
                            UINotificationFeedbackGenerator().notificationOccurred(.success)
                            onCommit(jpeg, rendered)
                        } else {
                            onCancel()
                        }
                    }
                    .fontWeight(.semibold)
                    .foregroundStyle(VeloTheme.emerald)
                }
            }
        }
    }

    private func colorButton(_ key: String, color: Color) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            selectedColorKey = key
        } label: {
            Circle()
                .fill(color)
                .frame(width: 22, height: 22)
                .overlay(
                    Circle()
                        .strokeBorder(.white, lineWidth: selectedColorKey == key ? 2.5 : 0)
                )
        }
        .buttonStyle(.plain)
    }

    private func aspectFitRect(imageSize: CGSize, in container: CGSize) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0, container.width > 0, container.height > 0 else {
            return CGRect(origin: .zero, size: container)
        }
        let pad: CGFloat = 12
        let availW = max(20, container.width - pad * 2)
        let availH = max(20, container.height - pad * 2)
        let scale = min(availW / imageSize.width, availH / imageSize.height)
        let w = imageSize.width * scale
        let h = imageSize.height * scale
        return CGRect(
            x: (container.width - w) * 0.5,
            y: (container.height - h) * 0.5,
            width: w,
            height: h
        )
    }

    private func normalize(point: CGPoint, in rect: CGRect) -> CGPoint {
        guard rect.width > 0, rect.height > 0 else { return .zero }
        let nx = min(1, max(0, (point.x - rect.minX) / rect.width))
        let ny = min(1, max(0, (point.y - rect.minY) / rect.height))
        return CGPoint(x: nx, y: ny)
    }

    private func denormalize(_ norm: CGPoint, in rect: CGRect) -> CGPoint {
        CGPoint(
            x: rect.minX + norm.x * rect.width,
            y: rect.minY + norm.y * rect.height
        )
    }

    private func drawStroke(_ s: MarkupStrokeItem, in rect: CGRect, context: inout GraphicsContext) {
        guard s.normalizedPoints.count >= 2 else { return }
        let pts = s.normalizedPoints.map { denormalize($0, in: rect) }
        let lineW = max(3.0, min(rect.width, rect.height) * 0.0085)

        switch s.tool {
        case .pen:
            var path = Path()
            path.move(to: pts[0])
            for p in pts.dropFirst() {
                path.addLine(to: p)
            }
            context.stroke(
                path,
                with: .color(s.swiftUIColor),
                style: StrokeStyle(lineWidth: lineW, lineCap: .round, lineJoin: .round)
            )
        case .box:
            let p0 = pts[0]
            let p1 = pts[pts.count - 1]
            let box = CGRect(
                x: min(p0.x, p1.x),
                y: min(p0.y, p1.y),
                width: abs(p1.x - p0.x),
                height: abs(p1.y - p0.y)
            )
            let path = Path(roundedRect: box, cornerRadius: 6)
            context.stroke(path, with: .color(s.swiftUIColor), style: StrokeStyle(lineWidth: lineW))
        case .arrow:
            let start = pts[0]
            let end = pts[pts.count - 1]
            var path = Path()
            path.move(to: start)
            path.addLine(to: end)

            let angle = atan2(end.y - start.y, end.x - start.x)
            let headLen = lineW * 4.2
            let wing1 = CGPoint(
                x: end.x - headLen * cos(angle - .pi / 6),
                y: end.y - headLen * sin(angle - .pi / 6)
            )
            let wing2 = CGPoint(
                x: end.x - headLen * cos(angle + .pi / 6),
                y: end.y - headLen * sin(angle + .pi / 6)
            )
            path.move(to: end)
            path.addLine(to: wing1)
            path.move(to: end)
            path.addLine(to: wing2)
            context.stroke(
                path,
                with: .color(s.swiftUIColor),
                style: StrokeStyle(lineWidth: lineW, lineCap: .round, lineJoin: .round)
            )
        }
    }

    private func renderFlattenedImage() -> UIImage {
        let maxDim: CGFloat = 1600
        let origW = max(1, originalImage.size.width)
        let origH = max(1, originalImage.size.height)
        let downScale = min(1.0, maxDim / max(origW, origH))
        let targetSize = CGSize(width: round(origW * downScale), height: round(origH * downScale))
        let fullRect = CGRect(origin: .zero, size: targetSize)

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)

        return renderer.image { ctx in
            originalImage.draw(in: fullRect)
            let cg = ctx.cgContext
            let lineW = max(4.0, min(targetSize.width, targetSize.height) * 0.0085)

            for s in strokes {
                guard s.normalizedPoints.count >= 2 else { continue }
                let pts = s.normalizedPoints.map {
                    CGPoint(x: $0.x * targetSize.width, y: $0.y * targetSize.height)
                }
                cg.setStrokeColor(s.uiColor.cgColor)
                cg.setLineWidth(lineW)
                cg.setLineCap(.round)
                cg.setLineJoin(.round)

                switch s.tool {
                case .pen:
                    cg.beginPath()
                    cg.move(to: pts[0])
                    for p in pts.dropFirst() {
                        cg.addLine(to: p)
                    }
                    cg.strokePath()
                case .box:
                    let p0 = pts[0]
                    let p1 = pts[pts.count - 1]
                    let box = CGRect(
                        x: min(p0.x, p1.x),
                        y: min(p0.y, p1.y),
                        width: abs(p1.x - p0.x),
                        height: abs(p1.y - p0.y)
                    )
                    let bez = UIBezierPath(roundedRect: box, cornerRadius: 8)
                    bez.lineWidth = lineW
                    s.uiColor.setStroke()
                    bez.stroke()
                case .arrow:
                    let start = pts[0]
                    let end = pts[pts.count - 1]
                    let angle = atan2(end.y - start.y, end.x - start.x)
                    let headLen = lineW * 4.2
                    let wing1 = CGPoint(
                        x: end.x - headLen * cos(angle - .pi / 6),
                        y: end.y - headLen * sin(angle - .pi / 6)
                    )
                    let wing2 = CGPoint(
                        x: end.x - headLen * cos(angle + .pi / 6),
                        y: end.y - headLen * sin(angle + .pi / 6)
                    )
                    cg.beginPath()
                    cg.move(to: start)
                    cg.addLine(to: end)
                    cg.move(to: end)
                    cg.addLine(to: wing1)
                    cg.move(to: end)
                    cg.addLine(to: wing2)
                    cg.strokePath()
                }
            }
        }
    }
}
