// Prints an eslint or oxlint JSON report in the "file: line L, col C, severity - message" shape matcher.json reads.
// Errors always print; warnings only on the files listed in CHANGED_FILES, when that list exists.
import {existsSync, readFileSync} from "node:fs"
import {resolve} from "node:path"

const [linter, reportPath] = process.argv.slice(2)

// Each reader flattens its report to {file, line, column, isError, message, rule}, file being absolute.
const readers = {
    eslint: (report) => report.flatMap(({filePath, messages}) => messages.map((m) => ({
        file: filePath,
        line: m.line,
        column: m.column,
        isError: m.severity === 2,
        message: m.message,
        rule: m.ruleId,
    }))),
    oxlint: (report) => report.diagnostics.map((d) => ({
        file: resolve(d.filename),
        line: d.labels?.[0]?.span?.line,
        column: d.labels?.[0]?.span?.column,
        isError: d.severity === "error",
        message: d.message,
        rule: d.code,
    })),
}

let findings
try {
    findings = readers[linter](JSON.parse(readFileSync(reportPath, "utf8")))
} catch {
    // The linter crashed before writing a usable report; its own stderr and exit code already say why.
    if (reportPath && existsSync(reportPath)) {
        process.stdout.write(readFileSync(reportPath, "utf8"))
    }
    process.exit(0)
}

const changedPath = process.env.CHANGED_FILES
const changed = changedPath && existsSync(changedPath)
    ? new Set(readFileSync(changedPath, "utf8").split("\n").filter(Boolean).map((file) => resolve(file)))
    : undefined

let errors = 0
let warnings = 0
let skippedWarnings = 0

for (const {file, line, column, isError, message, rule} of findings) {
    if (isError) {
        errors++
    } else {
        warnings++
        if (changed && !changed.has(file)) {
            skippedWarnings++
            continue
        }
    }
    const text = message.replace(/\s*\n\s*/g, " ")
    const suffix = rule ? ` (${rule})` : ""
    console.log(`${file}: line ${line ?? 1}, col ${column ?? 1}, ${isError ? "error" : "warning"} - ${text}${suffix}`)
}

const skipped = skippedWarnings ? `, ${skippedWarnings} of them on files this PR does not touch and left unannotated` : ""
console.log(`${linter}: ${errors} error(s), ${warnings} warning(s)${skipped}`)
