"""Public output adapters. Control JSON and private reasoning stay out of chat."""
import json


class RouteText:
    def __init__(self, emit):
        self.emit, self.buffer, self.decided, self.visible = emit, '', False, False

    def push(self, piece):
        self.buffer += piece
        if not self.decided:
            head = self.buffer.lstrip()
            if not head or head in ('`', '``') or (head.startswith('```') and '\n' not in head):
                return
            if head.startswith('```'):
                language, body = head[3:].split('\n',1)
                if not body.strip() and language.strip() in ('','json'): return
                control = language.strip() == 'json' or body.lstrip().startswith('{')
            else: control = head.startswith('{')
            self.decided = True
            self.visible = not control
            if self.visible: self.emit('token', self.buffer)
        elif self.visible:
            self.emit('token', piece)


class ReportText:
    """Decode only the report string in a streamed delivery tool argument.

    json.loads validates each complete string prefix, including split escapes and
    surrogate pairs. Other tool arguments and delivery control fields never leak.
    """
    def __init__(self, emit):
        self.emit, self.previous = emit, ''

    def push(self, index, name, arguments):
        if index != 0 or name != 'submit_deliverable': return
        # Match actual top-level keys, never a similarly named key inside a value.
        decoder = json.JSONDecoder()
        pos = 0
        try:
            pos = arguments.index('{') + 1
            while True:
                while pos < len(arguments) and arguments[pos] in ' \r\n\t,': pos += 1
                key, pos = decoder.raw_decode(arguments, pos)
                while pos < len(arguments) and arguments[pos].isspace(): pos += 1
                if arguments[pos] != ':': return
                pos += 1
                while pos < len(arguments) and arguments[pos].isspace(): pos += 1
                if key == 'report': break
                _, pos = decoder.raw_decode(arguments, pos)
            if arguments[pos] != '"': return
            start = pos
            pos += 1
            escaped = False
            while pos < len(arguments):
                char = arguments[pos]
                if not escaped and char == '"': break
                if not escaped and char == '\\': escaped = True
                else: escaped = False
                pos += 1
            partial = arguments[start:pos]
            # A trailing escape/unicode sequence is not yet a valid JSON string.
            for trim in range(min(12, len(partial))):
                try:
                    value = json.loads(partial[:len(partial)-trim] + '"')
                    if value and 0xD800 <= ord(value[-1]) <= 0xDBFF: continue
                    if any(0xD800 <= ord(c) <= 0xDFFF for c in value): return
                    if value.startswith(self.previous):
                        delta = value[len(self.previous):]
                        if delta: self.emit('token', delta)
                        self.previous = value
                    return
                except (ValueError, TypeError): continue
        except (ValueError, TypeError, IndexError): return
