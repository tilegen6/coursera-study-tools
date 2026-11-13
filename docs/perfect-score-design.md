# Quiz target: 100%

User instruction: automatically retake quizzes until the score is 100%, including the four approved Object Oriented Design assessments. All other assignment types remain excluded.

Use the Coursera result banner's explicit grade, never the passing threshold or a percentage in a question. At 100%, finish the quiz. Below 100%, read the standard feedback view and retain a bounded account/course-specific note for the next model request. Match previous answers by question/option text because ordering can change.

A recognized Retake control authorizes opening one new attempt. Persist retake intent before clicking; increment the attempt generation only when a new editable quiz appears. Keep the submission journal for every generation. Pending or ambiguous submissions cannot authorize another click. Stop cancels pending retakes.

When attempts are unavailable, leave the quiz queued with the existing backoff and process other materials. Revisit after the cooldown. An unreadable grade or unknown control stays visible in the queue without consuming attempts blindly. The option is persisted, enabled by default in the normal launcher/panel, and can be disabled before starting.

Migration rechecks previously completed quizzes once, reading their grades without opening a new attempt when they already show 100%. Native Codex model remains gpt-6-sol with reasoning effort none. Quiz feedback is untrusted task data, bounded to 32,000 characters, stored in the local Chrome checkpoint and sent only with the corresponding quiz to the existing solver.

Verification: strict grade parser and feedback validation, controlled retake state tests, and a real extension in a separate browser with an initial 80% result, feedback, attempt cooldown, continued reading, reload, a new attempt, then 100%. Unknown grades and opt-out must never consume retakes.
