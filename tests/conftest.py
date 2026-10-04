import os

# в тестах шансы на победу не считаем (симуляция занимает CPU) — кроме тестов, которые включают её сами
os.environ.setdefault("WINPROB_BUDGET", "0")
