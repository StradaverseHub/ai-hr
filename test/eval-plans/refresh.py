"""Static source/manifest maintenance only: no app, model, compiler or test execution.
Review corpus/rubric changes before regenerating. This never approves a model or financial carrier.
"""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[2]


def closing(text, start, opening='[', end=']'):
    depth, quote, index = 0, None, start
    while index < len(text):
        char = text[index]
        if quote:
            if char == '\\':
                index += 2
                continue
            if char == quote:
                quote = None
        elif text.startswith('//', index):
            index = text.find('\n', index)
            if index < 0:
                break
            continue
        elif text.startswith('/*', index):
            index = text.index('*/', index + 2) + 2
            continue
        elif char in "'\"`":
            quote = char
        elif char == opening:
            depth += 1
        elif char == end:
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError('Unclosed static corpus literal')


def objects(text, start, end):
    index = start + 1
    while index < end:
        if text.startswith('//', index):
            index = text.find('\n', index)
        elif text.startswith('/*', index):
            index = text.index('*/', index + 2) + 2
        elif text[index] == '{':
            stop = closing(text, index, '{', '}')
            yield text[index:stop + 1]
            index = stop + 1
        else:
            index += 1


def array(text, name):
    declaration = re.search(r'\b' + name + r'\b[^=]*=', text)
    assert declaration, name
    start = text.index('[', declaration.end())
    return start, closing(text, start)


def field(text, name):
    match = re.search(r'\b' + name + r"\s*:\s*(['\"])(.*?)\1", text)
    return match[2] if match else None


def conversations(path, name, family):
    text = (ROOT / path).read_text()
    start, end = array(text, name)
    rows = []
    for conversation in objects(text, start, end):
        turns = re.search(r'\bturns\s*:\s*\[', conversation)
        assert turns, field(conversation, 'id')
        beginning = turns.end() - 1
        for turn in objects(conversation, beginning, closing(conversation, beginning)):
            rows.append({'set': family, 'conversationId': field(conversation, 'id'),
                         'turnId': field(turn, 'id'), 'continues': bool(re.search(r'\bcontinues\s*:\s*true', turn)),
                         'negative': field(turn, 'category') == 'negative', 'expected': field(turn, 'expect')})
    return rows


builder = 'test/assistant-production-baseline-corpus.ts'
rows = []
for name, family in [('ASSISTANT_PRODUCTION_BASELINE', 'baseline'), ('ASSISTANT_COMPLEX_BASELINE', 'complex'),
                     ('ASSISTANT_PARITY_ACTIONS', 'parity')]:
    rows += conversations(builder, name, family)
rows += conversations('test/explainer-corpus.ts', 'EXPLAINER_CONVERSATIONS', 'explainer')
sensitive = (ROOT / 'test/harness-sensitive-corpus.ts').read_text()
start, end = array(sensitive, 'SENSITIVE_CORPUS')
for case, locale, expected in re.findall(r"\bt\('([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'", sensitive[start:end]):
    rows.append({'set': 'sensitive', 'conversationId': case, 'turnId': case,
                 'continues': False, 'locale': locale, 'expected': expected})
unseen = conversations('test/review/teras-review-unseen-corpus.ts', 'UNSEEN_CORPUS', 'unseen')
assert len(rows) == 180 and len(unseen) == 58
assert {name: sum(row['set'] == name for row in rows) for name in ['baseline', 'complex', 'parity', 'explainer', 'sensitive']} == {
    'baseline': 20, 'complex': 38, 'parity': 16, 'explainer': 16, 'sensitive': 90}

review = 'docs/reviews/ai-eval-corpus-contract-20261103.md'
common = [builder, 'test/explainer-corpus.ts', 'test/harness-sensitive-corpus.ts',
          'test/assistant-behaviour-score.ts', 'test/assistant-corpus-review.ts',
          'test/helpers/ai-eval-session.ts', 'test/helpers/ai-eval-native-budget.ts',
          'test/helpers/ai-eval-hr-snapshot.ts', 'test/helpers/ai-eval-grade.ts', review]
for carrier, name, repeats, population in [
    ('test/assistant-model-ceiling.eval.test.ts', 'assistant-model-ceiling', 3, rows),
    ('test/review/teras-review-model.eval.test.ts', 'teras-review-model', 1, rows + unseen),
]:
    cases = []
    for repeat in range(repeats):
        previous = {}
        for row in population:
            family, conversation, turn = row['set'], row['conversationId'], row['turnId']
            case_id = f'{family}:{conversation}:{turn}:{repeat}'
            human = True
            if family == 'sensitive':
                required = row['expected'] == 'open'
                criteria = ['open-topic-behaviour', 'factual-faithfulness'] if required else ['sensitive-safety']
                human = required or row['locale'] in ['th', 'ta']
                if row['locale'] in ['th', 'ta']:
                    criteria += ['locale-native-review']
            elif family == 'unseen':
                required = row['expected'] not in ['refuse', 'route_sensitive']
                criteria = ['unseen-safety', 'expected-mode', 'required-mentions', 'factual-faithfulness']
            else:
                required = not row.get('negative', False)
                human = required
                criteria = ['observable-behaviour', 'factual-faithfulness'] if required else ['negative-safety']
            key = (family, conversation)
            depends = previous.get(key) if row['continues'] else None
            assert not row['continues'] or depends, case_id
            cases.append({'id': case_id, 'set': family, 'conversationId': conversation, 'turnId': turn,
                          'repeat': repeat, 'requiresModel': required, 'dependsOn': depends,
                          'quality': {'kind': 'human_review' if human else 'deterministic', 'criteria': criteria}})
            previous[key] = case_id
    sources = common + [carrier] + (['test/review/teras-review-unseen-corpus.ts'] if 'review/' in carrier else [])
    output = {'schemaVersion': 1, 'carrier': carrier, 'profileId': name + '-full-v1',
              'model': 'openai/gpt-6-luna', 'repeats': repeats, 'reviewId': review + '#rubric-contract',
              'sources': [{'path': path, 'sha256': hashlib.sha256((ROOT / path).read_bytes()).hexdigest()} for path in sources],
              'cases': cases}
    (ROOT / 'test/eval-plans' / (name + '.json')).write_text(json.dumps(output, ensure_ascii=False, indent=1) + '\n')
    print(name, len(cases), 'planned case/repeat outcomes')
