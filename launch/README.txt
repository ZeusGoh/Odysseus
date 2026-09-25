ODYSSEUS - ANALYST LAUNCHERS
===========================

Double-click any of these. Nothing here needs you to type a command.

  0  Ask the analyst (chat)      Talk to it in your own words, in a terminal.
                                 (With 10 running, the same conversation is
                                 available inside Odysseus -> Analyst.)

  1  First run                   Do this ONCE. Puts the config in place, runs
                                 the tests, checks the engine against the real
                                 Bybit API, then runs one analyst read.

  2  What is worth reading now    FREE. No model calls. Scans every liquid
                                 coin on the exchange (mcp\watchlist.json,
                                 scope "board") and ranks what it flagged.

  3  Run the analyst now          Reads the top of that ranking - five a pass
                                 by default - and names the rest for next
                                 hour. Uses your Claude subscription.

  4  Read one coin                Forces a full read on a coin you name, even if
                                 nothing has happened to it.

  5  Send latest report to the app  Pushes the report into Odysseus ->
                                 Trading -> Analyst.

  6  Start hourly watching        (Now every 30 minutes - the name is old.) It
                                 scans by itself, hidden, while the PC is
                                 awake; a pass missed while asleep runs when
                                 it wakes. Quiet passes cost nothing.

  7  Stop hourly watching         Removes the automatic pass.

  8  Open the log                 What it has been doing.

  9  Set up auto-publish to app   Do this ONCE. Saves your Cloud login locally
                                 so reports land in the app by themselves -
                                 nothing to run or drag in by hand after this.

 10  Start the app relay          Then use the buttons in Odysseus -> Analyst
                                 instead of 2, 3, 4, 5, 6 and 7. Runs minimised;
                                 close its window to stop it. Buttons cover
                                 everything here, including asking questions.

 11  Relay always on              Do this ONCE instead of 10. The relay starts
                                 by itself at every logon, with no window, and
                                 restarts if it ever exits. Nothing to press
                                 again. Output: verdicts\relay.log.

 12  Relay off                    Undoes 11.


WHICH ONE DO I WANT?
--------------------
  "I want to ask it something"          ->  0
  "I'd rather click in the app"         ->  11 once, then Odysseus -> Analyst
  "Has anything happened?"              ->  2   (free)
  "Tell me about this specific coin"    ->  4
  "Do it for me from now on"            ->  6, then 9 so it reaches the app too


THE TWO ANALYSTS
----------------
A stochastic analyst sees only the indicator and the backtest record. A news
analyst sees only structure, positioning and headlines, plus its own web search.
Neither can see the other's data - they run in separate processes, so it is not
an instruction they could ignore.

Where they AGREE from different evidence is the strongest read this produces.
Where they CLASH is the useful part - it usually means the indicator likes a
move that is being carried by something it cannot see.

 13  Open on your phone          Serves the app to your phone over the home
                                 Wi-Fi and prints the address to open. Leave
                                 the window open. (Analyst chat and the Bybit
                                 line need the relay, which stays on the PC.)

 14  Allow phone through firewall  Do this ONCE, as administrator, if the phone
                                 cannot reach the address 13 shows.
