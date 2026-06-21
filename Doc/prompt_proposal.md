# PROMPT
all permission allow permission for accessing source code and excel or any other

I am a world-class best software engineer debugging and fixing /provinding best solution to complex mobile issues.

input:issue url : https://github.com/Expensify/App/issues/93660

Issue Analysis: 

STEP 5 — CROSS-CHECK 10 ANGLES

**Code & Architecture**
1. PR Diffs & File Changes
2. Component Architecture Analysis
3. TypeScript Type Errors

**Data Layer**
4. Onyx Data Flow Tracing
5. API Request / Response Analysis
6. Onyx Key Definitions
7. Optimistic Update Conflicts
8. Collection Key Correctness
9. Offline Queue Behavior

**Rendering & UI**
10. User Differentiation Logic
11. Re-render Analysis
12. Memoization Breakdown
13. React Compiler Compliance
14. Animation & Gesture Conflicts
15. Layout Measurement Issues
16. FlashList / FlatList Virtualization

**Navigation**
17. Navigation Params Correctness
18. Deep Link Handling
19. RHP vs Central Pane State
20. Stale Navigation After Back Press

**Platform Behavior**
21. Approval Notification / Sync Flow
22. iOS vs Android Differences
23. Web vs Mobile Differences
24. Orientation Changes
25. SafeArea / Keyboard Behavior
26. Screen Size / Viewport Differences

**Async & Timing**
27. Race Conditions
28. useEffect Cleanup
29. Promise Chain Handling
30. Debounce / Throttle Timing
31. setState After Unmount

**Performance & Memory**
32. Memory Leaks
33. Event Listener Cleanup
34. Infinite Render Loops
35. Expensive Computations in Render
36. Bundle / Import Issues

**Security & Permissions**
37. User Role / Permission Logic
38. Workspace Policy Settings
39. Feature Flags / GrowthBook Gates
40. canUseFeature Checks

**Historical Context**
41. Past Similar Issues
42. Previous Regressions
43. Related Closed PRs
44. CHANGELOG Analysis

**Evidence & Assignment**
45. BrowserStack / Video Evidence
46. Merge Timing & Staging Builds
47. Correct PR Assignment
48. Reproduction Steps Validation
49. Portrait vs Landscape Testing


STEP 7 — LIST 5 EDGE CASES
Think of cases the original reporter did NOT test.
check this Edge case
- Qualifier variant
- Domain variant
- Happy path
- State timing
- Forward+back
- Entry point
- Orientation
- Rendering & UI
- Platform Behavior
- Data State
- Async & Timing
- Performance
- Empty States


STEP 8 : check
1. [ ] I read the actual source file (not just the issue description)
2. [ ] I have a file path + line number for the root cause
3. [ ] I can explain WHY it only reproduces under specific conditions
4. [ ] My fix addresses the root cause (not just a symptom)
5. [ ] I checked if the deploy blocker is assigned to the correct PR
6. [ ] I have at least 1 or  2 fix options
7. [ ] I listed edge cases
8. [ ] My confidence level is honest
9. [ ] My proposal is MORE detailed than MevinBot's


GO DEEPER THAN MELVINBOT:
MevinBot only checks PR merge timing and file diffs.
YOU must read actual source code, find the exact line, and explain the mechanism.
Your proposal must include file path + line number + exact code snippet.

Root cause analysis and fix step


### Output


Provide Proposal including
- Root Case :      
    - Primary Root Cause : [output]
    - Secondary Root Cause : [output]
    - Affected Files : [output]
    - Affected Component(s) : [output]
    - Bug Category : [output]
        code snippet , 
        explain why what when how
        State the exact file + line number
        Paste the exact problematic code
        Explain WHY it causes the bug step by step
        Explain WHY it only happens under specific conditions (orientation, empty state, etc.)
        code snippet Before/After
        Read every file changed in the suspected PRs
        Find the EXACT line number that causes the bug
        Trace the full code path: user action → component → render → layout
        Look for: inline unmemoized objects, style mutations, FlashList/FlatList props, useEffect deps

- Bug fix 
    - Fix Option 1 (Recommended) : [output]
    - Fix Option 2 (Alternative) : [output]
    - Revert Option : [output]
        PROPOSE 2 FIXES
        For each fix:
        Exact file path and line number to change
        Why this fix works
        Before/After code snippet 
    
| Fix Option | Description | Files to Change | Effort | Risk | Status | PR Link | Verified By |
|---|---|---|---|---|---|---|---|
| Option 1 – Validation-aware flow model (RECOMMENDED) | Add `isAccountValidated` to OnboardingFlowContext; in `getDomainPrefix` return `[]` for validated public-domain users so the work-email screens (unreachable for them) drop out of the flow. EMPLOYEES becomes step 1 → back button hidden. | `src/libs/getOnboardingStepCounter.ts` (10-16, 73-89) + `src/pages/OnboardingEmployees/BaseOnboardingEmployees.tsx` (43-52, add `account.validated`) | Low | Low | Recommended – addresses root cause | | |
| Option 2 – Set skipped flag on validated auto-forward | In `BaseOnboardingWorkEmail.tsx` validated-account branch (92-94) call `setOnboardingMergeAccountStepValue(true, true)` for VSB/SMB before forceReplacing to Employees, reusing the existing `=== true` → `[]` handling. | `src/pages/OnboardingWorkEmail/BaseOnboardingWorkEmail.tsx` (92-94) | Low | Medium | Alternative – reuses existing branch but writes NVP state as a nav side-effect | | |
| Option 3 – Symptom patch in Employees screen | Treat `undefined` `isMergeAccountStepSkipped` as skipped, or hide back button when previous route is unreachable. | `src/pages/OnboardingEmployees/BaseOnboardingEmployees.tsx` (35, 54-63, 126) | Low | Medium | Rejected – masks model/navigation divergence | | |



- Alternate fix
- Edge case

VALIDATION	: 	: [output]

- Confidence Level :[output]
- Platforms Tested :[output]
- Reproduced Locally? :[output]
- Evidence Links :[output]
- if miss any thing then add :[output]

Final output : Proposal file download
show in chat window the proposal as per roposal template in Expensify