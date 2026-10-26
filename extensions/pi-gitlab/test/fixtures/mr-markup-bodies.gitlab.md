<gitlab-mr source="https://gitlab.com/ci/mr-log-bot/-/merge_requests/7" iid="7" title="Bot-decorated description" state="opened" author="@alice" operator_author="true" pipeline="running" fetched_at="2024-05-03T09:12:00Z">

<description>
Implements the fix. A CI bot appends its log below — HTML markup flows
through the file grammar verbatim:
<details>
<summary>CI log (click to expand)</summary>

```
$ npm test
all green
```

</details>
&lt;howdy&gt; said the bot — entity-looking lines are content too, untouched
</description>

<discussion_thread id="ab12cd34ef56ab78" resolved="false">

<comment author="@ci-bot" id="501" from_operator="false" created_at="2024-05-03T09:00Z">
Full log below:
<details>
<summary>raw</summary>
</details>
</comment>

<comment author="@alice" id="502" visible="unpublished" from_operator="true" created_at="2024-05-03T09:10Z">
<b>not bold</b> — markup at line start is staged content like any other.
Interior markup like <details> needs no special handling either.
</comment>

</discussion_thread>

</gitlab-mr>
