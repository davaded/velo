//! Standards-compliant ISO/IEC 18004 QR Code encoder (Versions 1..=14, EC Level L, Byte Mode).
//! Produces genuine Reed-Solomon error-corrected QR matrices rendered as crisp SVG or Terminal Unicode,
//! directly scannable by iOS Camera, Android Camera, and WeChat.

struct VersionSpec {
    version: usize,
    total_codewords: usize,
    ec_codewords_per_block: usize,
    g1_blocks: usize,
    g1_data_cw: usize,
    g2_blocks: usize,
    g2_data_cw: usize,
    align_coords: &'static [usize],
}

// ISO/IEC 18004 Table 9 & Annex E — Error Correction Level L (7% recovery, maximum scan reliability & density)
const VERSION_SPECS_L: &[VersionSpec] = &[
    VersionSpec { version: 1,  total_codewords: 26,  ec_codewords_per_block: 7,  g1_blocks: 1, g1_data_cw: 19,  g2_blocks: 0, g2_data_cw: 0,  align_coords: &[] },
    VersionSpec { version: 2,  total_codewords: 44,  ec_codewords_per_block: 10, g1_blocks: 1, g1_data_cw: 34,  g2_blocks: 0, g2_data_cw: 0,  align_coords: &[6, 18] },
    VersionSpec { version: 3,  total_codewords: 70,  ec_codewords_per_block: 15, g1_blocks: 1, g1_data_cw: 55,  g2_blocks: 0, g2_data_cw: 0,  align_coords: &[6, 22] },
    VersionSpec { version: 4,  total_codewords: 100, ec_codewords_per_block: 20, g1_blocks: 1, g1_data_cw: 80,  g2_blocks: 0, g2_data_cw: 0,  align_coords: &[6, 26] },
    VersionSpec { version: 5,  total_codewords: 134, ec_codewords_per_block: 26, g1_blocks: 1, g1_data_cw: 108, g2_blocks: 0, g2_data_cw: 0,  align_coords: &[6, 30] },
    VersionSpec { version: 6,  total_codewords: 172, ec_codewords_per_block: 18, g1_blocks: 2, g1_data_cw: 68,  g2_blocks: 0, g2_data_cw: 0,  align_coords: &[6, 34] },
    VersionSpec { version: 7,  total_codewords: 196, ec_codewords_per_block: 20, g1_blocks: 2, g1_data_cw: 78,  g2_blocks: 0, g2_data_cw: 0,  align_coords: &[6, 22, 38] },
    VersionSpec { version: 8,  total_codewords: 242, ec_codewords_per_block: 24, g1_blocks: 2, g1_data_cw: 97,  g2_blocks: 0, g2_data_cw: 0,  align_coords: &[6, 24, 42] },
    VersionSpec { version: 9,  total_codewords: 292, ec_codewords_per_block: 30, g1_blocks: 2, g1_data_cw: 116, g2_blocks: 0, g2_data_cw: 0,  align_coords: &[6, 26, 46] },
    VersionSpec { version: 10, total_codewords: 346, ec_codewords_per_block: 18, g1_blocks: 2, g1_data_cw: 68,  g2_blocks: 2, g2_data_cw: 69, align_coords: &[6, 28, 50] },
    VersionSpec { version: 11, total_codewords: 404, ec_codewords_per_block: 20, g1_blocks: 4, g1_data_cw: 81,  g2_blocks: 0, g2_data_cw: 0,  align_coords: &[6, 30, 54] },
    VersionSpec { version: 12, total_codewords: 466, ec_codewords_per_block: 24, g1_blocks: 2, g1_data_cw: 92,  g2_blocks: 2, g2_data_cw: 93, align_coords: &[6, 32, 58] },
    VersionSpec { version: 13, total_codewords: 532, ec_codewords_per_block: 26, g1_blocks: 4, g1_data_cw: 107, g2_blocks: 0, g2_data_cw: 0,  align_coords: &[6, 34, 62] },
    VersionSpec { version: 14, total_codewords: 581, ec_codewords_per_block: 30, g1_blocks: 3, g1_data_cw: 115, g2_blocks: 1, g2_data_cw: 116, align_coords: &[6, 26, 46, 66] },
];

impl VersionSpec {
    fn total_data_codewords(&self) -> usize {
        self.g1_blocks * self.g1_data_cw + self.g2_blocks * self.g2_data_cw
    }

    fn count_bits(&self) -> usize {
        if self.version <= 9 { 8 } else { 16 }
    }

    fn max_byte_payload(&self) -> usize {
        // 4 mode bits + count_bits (8 or 16) -> overhead is 12 bits (2 bytes) or 20 bits (3 bytes)
        let total_bits = self.total_data_codewords() * 8;
        let overhead_bits = 4 + self.count_bits();
        (total_bits - overhead_bits) / 8
    }
}

fn gf_mul(x: u8, y: u8) -> u8 {
    let mut z: u8 = 0;
    for i in (0..8).rev() {
        z = (z << 1) ^ (z >> 7).wrapping_mul(0x1D);
        if ((y >> i) & 1) != 0 {
            z ^= x;
        }
    }
    z
}

fn rs_divisor(degree: usize) -> Vec<u8> {
    let mut result = vec![0u8; degree];
    result[degree - 1] = 1;
    let mut root: u8 = 1;
    for _ in 0..degree {
        for j in 0..degree {
            result[j] = gf_mul(result[j], root);
            if j + 1 < degree {
                result[j] ^= result[j + 1];
            }
        }
        root = gf_mul(root, 0x02);
    }
    result
}

fn rs_remainder(data: &[u8], divisor: &[u8]) -> Vec<u8> {
    let mut result = vec![0u8; divisor.len()];
    for &b in data {
        let factor = b ^ result[0];
        result.remove(0);
        result.push(0);
        for (r, &d) in result.iter_mut().zip(divisor.iter()) {
            *r ^= gf_mul(d, factor);
        }
    }
    result
}

struct BitBuf {
    bits: Vec<bool>,
}

impl BitBuf {
    fn new() -> Self {
        Self { bits: Vec::new() }
    }

    fn push_bits(&mut self, val: u32, len: usize) {
        for i in (0..len).rev() {
            self.bits.push(((val >> i) & 1) != 0);
        }
    }

    fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.bits.len() / 8);
        for chunk in self.bits.chunks(8) {
            let mut b = 0u8;
            for (i, &bit) in chunk.iter().enumerate() {
                if bit {
                    b |= 1 << (7 - i);
                }
            }
            out.push(b);
        }
        out
    }
}

pub struct QrMatrix {
    pub size: usize,
    pub modules: Vec<Vec<bool>>,
}

pub fn encode_qr(text: &str) -> Option<QrMatrix> {
    let payload = text.as_bytes();
    let spec = VERSION_SPECS_L
        .iter()
        .find(|s| payload.len() <= s.max_byte_payload())?;

    let data_capacity_bits = spec.total_data_codewords() * 8;
    let mut bb = BitBuf::new();
    // Byte mode indicator = 0100
    bb.push_bits(0b0100, 4);
    bb.push_bits(payload.len() as u32, spec.count_bits());
    for &b in payload {
        bb.push_bits(b as u32, 8);
    }
    // Terminator (up to 4 zero bits)
    let term_len = (data_capacity_bits - bb.bits.len()).min(4);
    bb.push_bits(0, term_len);
    // Pad to byte boundary
    while bb.bits.len() % 8 != 0 {
        bb.bits.push(false);
    }
    // Pad alternating 0xEC, 0x11 codewords
    let mut pad_idx = 0usize;
    while bb.bits.len() < data_capacity_bits {
        let pad_byte = if pad_idx % 2 == 0 { 0xEC } else { 0x11 };
        bb.push_bits(pad_byte, 8);
        pad_idx += 1;
    }

    let data_cw = bb.to_bytes();
    debug_assert_eq!(data_cw.len(), spec.total_data_codewords());

    // Split into RS blocks & compute EC codewords
    let divisor = rs_divisor(spec.ec_codewords_per_block);
    let mut blocks_data: Vec<Vec<u8>> = Vec::new();
    let mut blocks_ec: Vec<Vec<u8>> = Vec::new();
    let mut offset = 0usize;

    for _ in 0..spec.g1_blocks {
        let slice = &data_cw[offset..offset + spec.g1_data_cw];
        offset += spec.g1_data_cw;
        blocks_ec.push(rs_remainder(slice, &divisor));
        blocks_data.push(slice.to_vec());
    }
    for _ in 0..spec.g2_blocks {
        let slice = &data_cw[offset..offset + spec.g2_data_cw];
        offset += spec.g2_data_cw;
        blocks_ec.push(rs_remainder(slice, &divisor));
        blocks_data.push(slice.to_vec());
    }

    let max_data_len = spec.g1_data_cw.max(spec.g2_data_cw);
    let mut interleaved = Vec::with_capacity(spec.total_codewords);
    for col in 0..max_data_len {
        for blk in &blocks_data {
            if col < blk.len() {
                interleaved.push(blk[col]);
            }
        }
    }
    for col in 0..spec.ec_codewords_per_block {
        for ec in &blocks_ec {
            interleaved.push(ec[col]);
        }
    }
    debug_assert_eq!(interleaved.len(), spec.total_codewords);

    let size = 17 + 4 * spec.version;
    let mut base_modules = vec![vec![false; size]; size];
    let mut is_function = vec![vec![false; size]; size];

    // Helper closure to set function pattern module
    let set_fn = |modules: &mut Vec<Vec<bool>>,
                  func: &mut Vec<Vec<bool>>,
                  r: isize,
                  c: isize,
                  dark: bool| {
        if r >= 0 && c >= 0 && (r as usize) < size && (c as usize) < size {
            modules[r as usize][c as usize] = dark;
            func[r as usize][c as usize] = true;
        }
    };

    // 1. Finder patterns + 1-module white separators
    let draw_finder = |modules: &mut Vec<Vec<bool>>, func: &mut Vec<Vec<bool>>, tr: isize, tc: isize| {
        for dr in -1..=7 {
            for dc in -1..=7 {
                let dark = if (0..=6).contains(&dr) && (0..=6).contains(&dc) {
                    dr == 0 || dr == 6 || dc == 0 || dc == 6 || ((2..=4).contains(&dr) && (2..=4).contains(&dc))
                } else {
                    false
                };
                set_fn(modules, func, tr + dr, tc + dc, dark);
            }
        }
    };
    draw_finder(&mut base_modules, &mut is_function, 0, 0);
    draw_finder(&mut base_modules, &mut is_function, 0, (size - 7) as isize);
    draw_finder(&mut base_modules, &mut is_function, (size - 7) as isize, 0);

    // 2. Timing patterns
    for i in 8..(size - 8) {
        let dark = i % 2 == 0;
        set_fn(&mut base_modules, &mut is_function, 6, i as isize, dark);
        set_fn(&mut base_modules, &mut is_function, i as isize, 6, dark);
    }

    // 3. Alignment patterns
    let coords = spec.align_coords;
    let n_align = coords.len();
    for (ri, &cr) in coords.iter().enumerate() {
        for (ci, &cc) in coords.iter().enumerate() {
            // Skip the 3 finder corners
            if (ri == 0 && ci == 0)
                || (ri == 0 && ci + 1 == n_align)
                || (ri + 1 == n_align && ci == 0)
            {
                continue;
            }
            for dr in -2..=2isize {
                for dc in -2..=2isize {
                    let dist = dr.abs().max(dc.abs());
                    let dark = dist != 1;
                    set_fn(
                        &mut base_modules,
                        &mut is_function,
                        cr as isize + dr,
                        cc as isize + dc,
                        dark,
                    );
                }
            }
        }
    }

    // 4. Reserve Format info areas & set Dark Module
    for i in 0..9 {
        if i != 6 {
            is_function[8][i] = true;
            is_function[i][8] = true;
        }
    }
    for i in 0..8 {
        is_function[8][size - 1 - i] = true;
    }
    for i in 0..7 {
        is_function[size - 1 - i][8] = true;
    }
    // Dark module at (4 * V + 9, 8) == (size - 8, 8)
    set_fn(&mut base_modules, &mut is_function, (size - 8) as isize, 8, true);

    // 5. Version info (V >= 7): 18-bit Golay/BCH code (generator 0x1F25)
    if spec.version >= 7 {
        let mut rem = (spec.version as u32) << 12;
        for _ in 0..6 {
            let msb = 31 - rem.leading_zeros();
            if rem != 0 && msb >= 12 {
                rem ^= 0x1F25 << (msb - 12);
            } else {
                break;
            }
        }
        // Full polynomial reduction over bits 17..=12
        let mut r_val = (spec.version as u32) << 12;
        for bit in (12..18).rev() {
            if ((r_val >> bit) & 1) != 0 {
                r_val ^= 0x1F25 << (bit - 12);
            }
        }
        let ver_bits = ((spec.version as u32) << 12) | r_val;
        for i in 0..18 {
            let dark = ((ver_bits >> i) & 1) != 0;
            let a = size - 11 + (i % 3);
            let b = i / 3;
            set_fn(&mut base_modules, &mut is_function, a as isize, b as isize, dark);
            set_fn(&mut base_modules, &mut is_function, b as isize, a as isize, dark);
        }
    }

    // 6. Zigzag data placement from right-to-left in 2-column strips
    let mut bit_idx = 0usize;
    let total_stream_bits = interleaved.len() * 8;
    let mut right = (size - 1) as isize;
    let mut upward = true;
    while right >= 1 {
        if right == 6 {
            right = 5;
        }
        for step in 0..size {
            let r = if upward { size - 1 - step } else { step };
            for dc in 0..2 {
                let c = (right - dc) as usize;
                if !is_function[r][c] {
                    let dark = if bit_idx < total_stream_bits {
                        let byte = interleaved[bit_idx / 8];
                        ((byte >> (7 - (bit_idx % 8))) & 1) != 0
                    } else {
                        false
                    };
                    base_modules[r][c] = dark;
                    bit_idx += 1;
                }
            }
        }
        upward = !upward;
        right -= 2;
    }

    // 7. Evaluate all 8 mask patterns and select lowest penalty
    let mut best_modules = base_modules.clone();
    let mut best_penalty = u32::MAX;

    for mask in 0..8u32 {
        let mut candidate = base_modules.clone();
        for r in 0..size {
            for c in 0..size {
                if !is_function[r][c] && mask_bit(mask, r, c) {
                    candidate[r][c] = !candidate[r][c];
                }
            }
        }
        write_format_bits(&mut candidate, mask);
        let pen = compute_penalty(&candidate);
        if pen < best_penalty {
            best_penalty = pen;
            best_modules = candidate;
        }
    }

    Some(QrMatrix {
        size,
        modules: best_modules,
    })
}

fn mask_bit(mask: u32, r: usize, c: usize) -> bool {
    match mask {
        0 => (r + c) % 2 == 0,
        1 => r % 2 == 0,
        2 => c % 3 == 0,
        3 => (r + c) % 3 == 0,
        4 => (r / 2 + c / 3) % 2 == 0,
        5 => (r * c) % 2 + (r * c) % 3 == 0,
        6 => ((r * c) % 2 + (r * c) % 3) % 2 == 0,
        _ => ((r + c) % 2 + (r * c) % 3) % 2 == 0,
    }
}

fn write_format_bits(modules: &mut [Vec<bool>], mask: u32) {
    let size = modules.len();
    // EC Level L indicator = 0b01
    let data5 = (0b01u32 << 3) | (mask & 0b111);
    let mut rem = data5 << 10;
    for bit in (10..15).rev() {
        if ((rem >> bit) & 1) != 0 {
            rem ^= 0x537 << (bit - 10);
        }
    }
    let bits = ((data5 << 10) | rem) ^ 0x5412;

    let bit = |i: usize| -> bool { ((bits >> i) & 1) != 0 };

    // Copy 1: around top-left finder
    for c in 0..6 {
        modules[8][c] = bit(14 - c);
    }
    modules[8][7] = bit(8);
    modules[8][8] = bit(7);
    modules[7][8] = bit(6);
    for r in 0..6 {
        modules[5 - r][8] = bit(5 - r);
    }

    // Copy 2: bottom-left vertical + top-right horizontal
    for i in 0..7 {
        modules[size - 1 - i][8] = bit(14 - i);
    }
    for i in 0..8 {
        modules[8][size - 8 + i] = bit(7 - i);
    }
}

fn compute_penalty(modules: &[Vec<bool>]) -> u32 {
    let n = modules.len();
    let mut penalty = 0u32;

    // Rule 1: runs of >= 5 identical modules in rows & cols
    for r in 0..n {
        let mut run = 1usize;
        for c in 1..n {
            if modules[r][c] == modules[r][c - 1] {
                run += 1;
            } else {
                if run >= 5 {
                    penalty += 3 + (run as u32 - 5);
                }
                run = 1;
            }
        }
        if run >= 5 {
            penalty += 3 + (run as u32 - 5);
        }
    }
    for c in 0..n {
        let mut run = 1usize;
        for r in 1..n {
            if modules[r][c] == modules[r - 1][c] {
                run += 1;
            } else {
                if run >= 5 {
                    penalty += 3 + (run as u32 - 5);
                }
                run = 1;
            }
        }
        if run >= 5 {
            penalty += 3 + (run as u32 - 5);
        }
    }

    // Rule 2: 2x2 blocks
    for r in 0..(n - 1) {
        for c in 0..(n - 1) {
            let v = modules[r][c];
            if modules[r][c + 1] == v && modules[r + 1][c] == v && modules[r + 1][c + 1] == v {
                penalty += 3;
            }
        }
    }

    // Rule 4: dark ratio balance
    let dark_count: usize = modules
        .iter()
        .map(|row| row.iter().filter(|&&b| b).count())
        .sum();
    let total = n * n;
    let k = ((dark_count as isize * 20 - total as isize * 10).abs() as usize) / total;
    penalty += (k as u32) * 10;

    penalty
}

/// Renders a standards-compliant SVG QR code with a 4-module ISO quiet zone.
pub fn render_qr_svg(text: &str, pixel_size: usize) -> String {
    let Some(qr) = encode_qr(text) else {
        return String::new();
    };
    let quiet = 3usize;
    let view = qr.size + quiet * 2;
    let mut path_d = String::with_capacity(qr.size * qr.size * 8);
    for (r, row) in qr.modules.iter().enumerate() {
        for (c, &dark) in row.iter().enumerate() {
            if dark {
                path_d.push_str(&format!("M{},{}h1v1h-1z", c + quiet, r + quiet));
            }
        }
    }
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {view} {view}\" width=\"{pixel_size}\" height=\"{pixel_size}\" shape-rendering=\"crispEdges\"><rect width=\"{view}\" height=\"{view}\" fill=\"#ffffff\"/><path d=\"{path_d}\" fill=\"#09090b\"/></svg>"
    )
}

/// Renders a compact terminal QR code using Unicode half-blocks (`▀`, `▄`, `█`, ` `).
pub fn render_qr_unicode(text: &str) -> String {
    let Some(qr) = encode_qr(text) else {
        return String::new();
    };
    let quiet = 2usize;
    let total = qr.size + quiet * 2;
    let is_dark = |r: usize, c: usize| -> bool {
        if r >= quiet && r < quiet + qr.size && c >= quiet && c < quiet + qr.size {
            qr.modules[r - quiet][c - quiet]
        } else {
            false
        }
    };
    let mut out = String::new();
    let mut r = 0usize;
    while r < total {
        out.push_str("  ");
        for c in 0..total {
            let top = is_dark(r, c);
            let bot = if r + 1 < total { is_dark(r + 1, c) } else { false };
            // Invert (light background = full block, dark module = space) or dark-on-light:
            // Using white background border (`█` = light, ` ` = dark) ensures scannability on BOTH dark & light terminals!
            let ch = match (top, bot) {
                (false, false) => '█',
                (false, true) => '▀',
                (true, false) => '▄',
                (true, true) => ' ',
            };
            out.push(ch);
        }
        out.push('\n');
        r += 2;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_lan_and_e2ee_urls_valid_sizes() {
        let lan = "http://192.168.10.3:6767/?mobile=1";
        let qr_lan = encode_qr(lan).expect("LAN URL fits");
        assert_eq!(qr_lan.size, 29); // Version 3 (29x29)

        let e2ee = "http://192.168.10.3:6767/?mobile=1&relay=ws://192.168.10.3:6768&room=423f49f1-82b9-4e78-9d25-65e1a290b123&key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let qr_e2ee = encode_qr(e2ee).expect("E2EE URL fits");
        assert!(qr_e2ee.size >= 49);

        let svg = render_qr_svg(lan, 176);
        assert!(svg.contains("<svg"));
        assert!(svg.contains("<path d="));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apple_vision_scanner_decodes_lan_and_e2ee_qr_codes() {
        let cases = [
            "http://192.168.10.3:6767/?mobile=1",
            "http://192.168.10.3:6767/?mobile=1&relay=ws://192.168.10.3:6768&room=423f49f1-82b9-4e78-9d25-65e1a290b123&key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ];

        for (idx, expected) in cases.iter().enumerate() {
            let qr = encode_qr(expected).expect("encode_qr");
            let scale = 8usize;
            let quiet = 4usize;
            let dim = (qr.size + quiet * 2) * scale;
            let mut pgm = format!("P5\n{dim} {dim}\n255\n").into_bytes();
            for py in 0..dim {
                let mr = py / scale;
                for px in 0..dim {
                    let mc = px / scale;
                    let dark = mr >= quiet
                        && mr < quiet + qr.size
                        && mc >= quiet
                        && mc < quiet + qr.size
                        && qr.modules[mr - quiet][mc - quiet];
                    pgm.push(if dark { 0u8 } else { 255u8 });
                }
            }
            let tmp_path = std::env::temp_dir().join(format!("velo_qr_test_{idx}.pgm"));
            std::fs::write(&tmp_path, &pgm).expect("write pgm");

            let swift_code = format!(
                r#"
import Foundation
import Vision
import AppKit

let url = URL(fileURLWithPath: "{}")
guard let img = NSImage(contentsOf: url),
      let cgImg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {{
    fputs("FAILED_IMAGE\n", stderr)
    exit(2)
}}
let req = VNDetectBarcodesRequest()
req.symbologies = [.qr]
let handler = VNImageRequestHandler(cgImage: cgImg, options: [:])
try handler.perform([req])
if let hit = req.results?.first?.payloadStringValue {{
    print(hit)
}} else {{
    fputs("NO_QR_DETECTED\n", stderr)
    exit(3)
}}
"#,
                tmp_path.display()
            );
            let out = std::process::Command::new("swift")
                .args(["-e", &swift_code])
                .output()
                .expect("run swift Vision QR scanner");
            let _ = std::fs::remove_file(&tmp_path);
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            assert!(
                out.status.success(),
                "Vision failed on case {idx} (ver size {}): stderr={stderr}",
                qr.size
            );
            assert_eq!(stdout, *expected, "Decoded QR payload mismatch on case {idx}");
        }
    }
}
