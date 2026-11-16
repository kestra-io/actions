// Prints an eslint JSON report in the "file: line L, col C, severity - message" shape matcher.json reads.
// Errors always print; warnings only on the files listed in CHANGED_FILES, when that list exists.
import {existsSync, readFileSync} from "node:fs"
import {resolve} from "node:path"

const reportPath = process.argv[2]
if (!reportPath || !existsSync(reportPath)) {
    // eslint crashed before writing a report; its own stderr and exit code already say why.
    process.exit(0)
}

const changedPath = process.env.CHANGED_FILES
const changed = changedPath && existsSync(changedPath)
    ? new Set(readFileSync(changedPath, "utf8").split("\n").filter(Boolean).map((file) => resolve(file)))
    : undefined

let errors = 0
let warnings = 0
let skippedWarnings = 0

for (const {filePath, messages} of JSON.parse(readFileSync(reportPath, "utf8"))) {
    for (const {severity, line, column, message, ruleId} of messages) {
        const isError = severity === 2
        if (isError) {
            errors++
        } else {
            warnings++
            if (changed && !changed.has(filePath)) {
                skippedWarnings++
                continue
            }
        }
        const text = message.replace(/\s*\n\s*/g, " ")
        const rule = ruleId ? ` (${ruleId})` : ""
        console.log(`${filePath}: line ${line ?? 1}, col ${column ?? 1}, ${isError ? "error" : "warning"} - ${text}${rule}`)
    }
}

const skipped = skippedWarnings ? `, ${skippedWarnings} of them on files this PR does not touch and left unannotated` : ""
console.log(`eslint: ${errors} error(s), ${warnings} warning(s)${skipped}`)
