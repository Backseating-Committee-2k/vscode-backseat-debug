#!/usr/bin/env node

const doc = require("./bslang.tmLanguage.json")

const declarations = doc.repository

for (const key of Object.keys(declarations)) {
    const obj = declarations[key]
    const patterns = obj.patterns
    if (!patterns) {
        continue
    }
    if (patterns.length <= 1) {
        const keys = Object.keys(obj).filter(
            (a) => !["name", "patterns"].includes(a)
        )

        if (keys.length == 0) {
            if (!patterns[0].include) {
                console.warn(`useless patterns in ${key}`)
            }
        }
    }
}
