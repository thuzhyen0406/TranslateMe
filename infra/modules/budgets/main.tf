resource "aws_sns_topic" "budget_alerts" {
  name = "translateme-budget-alerts"
}

resource "aws_sns_topic_subscription" "team_emails" {
  for_each  = toset(var.member_emails)
  topic_arn = aws_sns_topic.budget_alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_budgets_budget" "cost_budget" {
  name              = "TranslateMe-Monthly-Budget"
  budget_type       = "COST"
  limit_amount      = "20"
  limit_unit        = "USD"
  time_unit         = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.budget_alerts.arn]
  }
}

variable "member_emails" {
  type = list(string)
}