<!-- gitlab file — staged edits: add <comment> blocks with visible="unpublished", flip
     resolved attributes, or edit the <description> body; then run gitlab_put.
     HTML comments like this one are ignored by the parser. -->

<gitlab-mr source="https://gitlab.com/my-group/my-project/-/merge_requests/42" iid="42" title="Fix empty-array handling" state="opened" author="@alice" operator_author="true" draft="false" head_sha="9b31f2e" pipeline="success" fetched_at="2024-05-02T14:20:05Z">

<description>
Fixes the crash on empty arrays and adds regression tests.
</description>

<discussion_thread id="77cc0192aa31bc09" resolved="false">

<comment author="@alice" id="779" from_operator="true" created_at="2024-05-01T11:03Z">
Good catch, fixed in 9b31f2e — see src/api/client.ts.
</comment>

<comment author="@reviewer" id="780" from_operator="false" created_at="2024-05-01T11:30Z">
Confirmed, works now.
</comment>

</discussion_thread>

</gitlab-mr>
