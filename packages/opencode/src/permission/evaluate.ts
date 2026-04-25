import { Wildcard } from "@/util"

type Rule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

function base(input: string) {
  if (!input.startsWith("*:")) return input
  return "*"
}

export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const rules = rulesets.flat()
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, base(rule.pattern)),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}
