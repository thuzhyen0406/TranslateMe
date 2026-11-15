import unittest
from unittest.mock import Mock

from infra.tools.migrate_p1 import key, migrate


class MigrationTests(unittest.TestCase):
    def database(self):
        client = Mock()
        client.get_paginator.return_value.paginate.return_value = [{"Items": [
            key("TENANT#t_one", "CONFIG"),
            {**key("TENANT#t_two", "CONFIG"), "GSI1PK": {"S": "PLATFORM#TENANTS"}, "GSI1SK": {"S": "t_two"}},
            {**key("TENANT#PLATFORM#SLUG#pending", "META"), "tenantId": {"S": "t_one"}},
            {**key("TENANT#PLATFORM#SLUG#published", "META"), "tenantId": {"S": "t_two"}},
            {**key("TENANT#PLATFORM#SLUG#orphaned", "META"), "tenantId": {"S": "t_one"}},
        ]}]
        client.get_item.side_effect = [
            {"Item": {"status": {"S": "PENDING"}}},
            {"Item": {"status": {"S": "ACTIVE"}}},
            {},
        ]
        return client

    def test_dry_run_only_reports_candidates(self):
        client = self.database()
        self.assertEqual(migrate(client, "TestTable", False), {"directory_candidates": 1, "legacy_slug_candidates": 2})
        client.update_item.assert_not_called()
        client.transact_write_items.assert_not_called()

    def test_apply_verifies_host_state_and_preserves_active_mapping(self):
        client = self.database()
        self.assertEqual(migrate(client, "TestTable", True), {
            "directory_candidates": 1, "directory_updated": 1,
            "legacy_slug_candidates": 2, "legacy_slugs_released": 2,
        })
        self.assertEqual(client.update_item.call_args.kwargs["Key"], key("TENANT#t_one", "CONFIG"))
        operations = [call.kwargs["TransactItems"] for call in client.transact_write_items.call_args_list]
        self.assertEqual([ops[0]["ConditionCheck"]["Key"] for ops in operations], [
            key("TENANT#t_one", "HOST#pending"), key("TENANT#t_one", "HOST#orphaned"),
        ])
        self.assertTrue(all("attribute_not_exists(verifiedAt)" in ops[1]["Delete"]["ConditionExpression"] for ops in operations))
