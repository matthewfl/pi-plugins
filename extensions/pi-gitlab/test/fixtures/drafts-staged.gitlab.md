<gitlab-mr source="https://gitlab.com/my-group/my-project/-/merge_requests/42" iid="42" title="Fix empty-array handling" state="opened" author="@alice" operator_author="true" draft="false" head_sha="9b31f2e" pipeline="success" fetched_at="2024-05-02T14:20:05Z">

<description>
Fixes the crash on empty arrays and adds regression tests.
</description>

<discussion_thread id="77cc0192aa31bc09" resolved="false">

<comment author="@reviewer" id="779" from_operator="false" created_at="2024-05-01T11:03Z">
Please add a test for the undefined case.
</comment>

<comment author="pi" id="unset" visible="unpublished" from_operator="false">
Added in 9b31f2e — covers undefined and null inputs.
</comment>

</discussion_thread>

<discussion_thread id="unset" file="src/api/client.ts" line="50" side="new" visible="unpublished">

<comment author="pi" id="unset" visible="unpublished" from_operator="false">
nit: this branch duplicates the check above
</comment>

</discussion_thread>

</gitlab-mr>
