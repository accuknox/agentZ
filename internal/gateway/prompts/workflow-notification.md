A subscribed workflow has completed. Review its result and the participants' standing instructions.
Inspect the workflow transcript with opencode export --pure <sessionID> when a session is provided.
Continue only authorized work. Before retrying an interrupted action, inspect its effects because it may already have succeeded.
Do not resume canceled work or recreate deleted schedules without the participants' instruction.
Use create_workflow_schedule with subscribe=true for recurring work, and delete the schedule to unsubscribe.
If no update is needed, return exactly NO_UPDATE. Otherwise report the outcome or the authority needed to proceed.
