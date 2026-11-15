import Foundation

/// "Wilson, …": whether a sentence Whisper heard starts with the companion's name, and what follows
/// it. Accent-, case- and punctuation-insensitive, with one letter of slack ("Willson", "Wilsen",
/// "Wilton", "Will son"), after up to two greeting words ("Hey Wilson", "OK so Wilson").
/// Mirrors parseWake in app/src/services/audio/wake.ts: change both together.
enum WakeWord {
    static let name = "wilson"
    static let leads: Set<String> = [
        "hey", "hi", "hello", "hallo", "hola", "ok", "okay", "oh", "ah", "a", "um", "uh", "hmm", "so", "yo", "alright", "right", "well",
    ]

    /// The words after the wake word (trimmed, first letter capitalised; "" for "Wilson" alone),
    /// or nil when the sentence does not start with it.
    static func parse(_ text: String) -> String? {
        let ws = words(text)
        var i = 0
        while i < min(2, ws.count), leads.contains(ws[i].key) { i += 1 }
        guard i < ws.count else { return nil }
        let end: String.Index
        if isName(ws[i].key) {
            end = ws[i].range.upperBound
        } else if i + 1 < ws.count, isName(ws[i].key + ws[i + 1].key) {
            end = ws[i + 1].range.upperBound // "Will son"
        } else {
            return nil
        }
        var rest = Substring(text[end...])
        while let c = rest.first, !(c.isLetter || c.isNumber) { rest = rest.dropFirst() }
        let trimmed = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "" }
        return first.uppercased() + trimmed.dropFirst()
    }

    static func isName(_ key: String) -> Bool {
        key.count >= 5 && key.count <= 8 && distance(key, name) <= 1
    }

    /// Words (letters and digits, with apostrophes inside them) and where they are in `text`;
    /// key: the word folded to plain lowercase letters ("Wilson's" -> "wilsons").
    static func words(_ text: String) -> [(key: String, range: Range<String.Index>)] {
        var out: [(key: String, range: Range<String.Index>)] = []
        var start: String.Index?
        var i = text.startIndex
        func close(at end: String.Index) {
            if let s = start {
                let key = fold(String(text[s ..< end])).filter { $0.isLetter || $0.isNumber }
                if !key.isEmpty { out.append((key, s ..< end)) }
            }
            start = nil
        }
        while i < text.endIndex {
            let c = text[i]
            if c.isLetter || c.isNumber || (start != nil && (c == "'" || c == "’")) {
                if start == nil { start = i }
            } else {
                close(at: i)
            }
            i = text.index(after: i)
        }
        close(at: text.endIndex)
        return out
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil).lowercased()
    }

    /// Levenshtein distance.
    static func distance(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        if a.isEmpty { return b.count }
        if b.isEmpty { return a.count }
        var prev = Array(0 ... b.count)
        var cur = Array(repeating: 0, count: b.count + 1)
        for i in 1 ... a.count {
            cur[0] = i
            for j in 1 ... b.count {
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
            }
            swap(&prev, &cur)
        }
        return prev[b.count]
    }

    /// The same cases as app/src/services/audio/__tests__/wake.test.ts. `buddy-audio --wake-selftest`
    /// runs them without loading any model; returns the number of failures.
    static let cases: [(String, String?)] = [
        ("Wilson, where is the cathedral?", "Where is the cathedral?"),
        ("Hey Wilson, where is the cathedral?", "Where is the cathedral?"),
        ("Hi, Wilson. What's open now?", "What's open now?"),
        ("Hey, Wilson!", ""),
        ("Wilson.", ""),
        ("wilson", ""),
        ("Willson, is it going to rain?", "Is it going to rain?"),
        ("Wilsen, tell me about the Alcázar.", "Tell me about the Alcázar."),
        ("Will son, what time is it?", "What time is it?"),
        ("WILSON — find me lunch", "Find me lunch"),
        ("Wilsón, ¿qué hora es?", "Qué hora es?"),
        ("Okay so Wilson, what's next?", "What's next?"),
        ("Wilson's going to help", "Going to help"),
        ("Where is the cathedral?", nil),
        ("I told Wilson about it.", nil),
        ("Nelson, where is it?", nil),
        ("Will someone help me?", nil),
        ("Willow trees are nice.", nil),
        ("Thank you.", nil),
        ("", nil),
        ("Hey hey hey Wilson", nil),
    ]

    static func selfTest() -> Int {
        var failures = 0
        for (input, expected) in cases {
            let got = parse(input)
            let ok = got == expected
            if !ok { failures += 1 }
            print("\(ok ? "ok  " : "FAIL") \(String(reflecting: input)) -> \(got.map { String(reflecting: $0) } ?? "nil")\(ok ? "" : " (expected \(expected.map { String(reflecting: $0) } ?? "nil"))")")
        }
        print(failures == 0 ? "wake word self-test: all \(cases.count) passed" : "wake word self-test: \(failures) of \(cases.count) failed")
        return failures
    }
}
