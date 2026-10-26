<gitlab-mr source="https://gitlab.com/my-group/my-project/-/merge_requests/42" iid="42" title="Fix empty-array handling" state="opened" author="@alice" operator_author="true" draft="false" head_sha="9b31f2e" pipeline="success" fetched_at="2024-05-02T14:20:05Z">

<description>
Fixes the crash on empty arrays.
</description>

<discussion_thread id="a3f1c2d455ab9e10" file="src/api/client.ts" line="42" side="new" resolved="false">

<code_context>
```ts
41  export function applyFilter(items) {
42    if (items.length && !filter(items)) {   // ← commented line
43      return [];
```
</code_context>

<comment author="@reviewer" id="771" from_operator="false" created_at="2024-05-01T10:12Z">
This null check looks wrong for empty arrays — `items` may be undefined.
</comment>

<!-- template — copy into a real <comment> block to reply:
<comment author="pi" id="unset" visible="unpublished">
…reply shown to @reviewer…
</comment>
-->

</discussion_thread>

<!-- new top-level thread template:
<discussion_thread id="unset" visible="unpublished">
<comment author="pi" id="unset" visible="unpublished">
…new standalone comment…
</comment>
</discussion_thread>

new code-commented thread template:
<discussion_thread id="unset" visible="unpublished" file="path/from/diff" line="123" side="new">
<comment author="pi" id="unset" visible="unpublished">
…review comment…
</comment>
</discussion_thread>
-->

</gitlab-mr>
