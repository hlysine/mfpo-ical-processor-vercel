import axios from 'axios';
import ical from 'node-ical';
import icalGenerator, { ICalCalendarMethod, ICalEventClass, ICalEventData } from 'ical-generator';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const COURSE_CODE_MAP: { [k: string]: string | undefined } = {
  MEDU3300: 'Human Structure',
  MEDU3400: 'Human Function',
  MEDU3500: 'Doctor & Patient',
  MEDU3160: 'Resilience',
  MEDU3700: 'Bioethics',
  MEDU3600: 'Pathology',
  MEDU3520: 'Clinical Anatomy',
  'MED3-EVT': 'MED3 Event',
  MEDU3110: 'Med',
  MEDU3200: 'Skills Module',
  MEDU3210: 'Sur',
  MEDU3310: 'ACP',
  MEDU3320: 'Chem Path',
  MEDU3330: 'Mic-bi',
  MEDU3340: 'Communication',
  MEDU3800: 'Bioethics',
  MEDU3360: 'Resilience',
  'MED4-EVT': 'MED4 Event',
};

function getCourseName(courseCode: string) {
  const courseName = COURSE_CODE_MAP[courseCode];
  if (courseName) {
    return courseName;
  }
  const match = /^(MED|SUR)\d-([A-Z&]{1,5})$/.exec(courseCode);
  if (match) {
    return `${match[2]} ${match[1] === 'MED' ? 'Med' : 'Sur'}`;
  }
  return courseCode;
}

function isEvent(obj: ical.CalendarComponent): obj is ical.VEvent {
  return obj.type === 'VEVENT';
}

function isCalendar(obj: ical.CalendarComponent): obj is ical.VCalendar {
  return obj.type === 'VCALENDAR';
}

export default async (req: VercelRequest, res: VercelResponse) => {
  const link = req.query.link;
  const filter = req.query.filter;

  if (typeof link !== 'string') {
    res.status(400).send('Bad request: link is not a string');
    return;
  }
  if (typeof filter !== 'string' && filter !== undefined) {
    res.status(400).send('Bad request: filter is not a string and is not empty');
    return;
  }

  const filterRegex = filter === undefined ? null : new RegExp(filter as string, 'i');

  // download file content

  const response = await axios.get(link as string, {
    responseType: 'text',
  });

  if (!response.data) {
    res.status(400).send('No data. Error: ' + response.statusText);
    return;
  }

  // fix line wrapping in the file

  const originalText: string = response.data;
  const validLine = /^(?:[a-zA-Z]+(?:;[^:=]+)?[:=]| )/;

  const lines = originalText.split(/\r\n|\r|\n/);
  const fixedLines = [];

  for (const line of lines) {
    if (validLine.test(line)) {
      fixedLines.push(line);
    } else {
      fixedLines.push(' ' + line);
    }
  }

  const fixedText = fixedLines.join('\r\n');

  // parse file

  const parseResult = await ical.async.parseICS(fixedText);
  const vCalendar = Object.values(parseResult).find(isCalendar);
  const vEvents = Object.values(parseResult).filter(isEvent);

  const calendar = icalGenerator();
  calendar.method((vCalendar?.method?.trim() as ICalCalendarMethod | undefined) ?? ICalCalendarMethod.PUBLISH);

  let prodId = vCalendar?.prodid;
  if (!prodId) {
    prodId = '//Lysine//MfpoIcalProcessor//EN';
  } else if (prodId.startsWith('-')) {
    prodId = prodId.substring(1);
  }
  calendar.prodId(prodId);

  calendar.name('MFPO Timetable');
  calendar.description('Class and exam schedule from MFPO, processed to improve formatting.');

  calendar.events(
    vEvents
      .map(event => {
        let courseCode: string | undefined;
        let sessionType: string | undefined;
        const match = /^(\w{4}\d{4}|MED3-EVT|MED4-EVT|(?:MED|SUR)\d-[A-Z&]{1,5}) \(([\w ()-/\\]+?)\)/.exec(
          event.summary
        );
        if (match) {
          courseCode = match[1];
          sessionType = match[2];
        } else if (event.summary) {
          const courseCodeMatch = /^(\w{4}\d{4}|MED3-EVT|MED4-EVT|(?:MED|SUR)\d-[A-Z&]{1,5})/.exec(event.summary);
          if (courseCodeMatch) {
            courseCode = courseCodeMatch[1];
          }
          if (event.summary.toLowerCase().includes('(assessment)')) {
            sessionType = 'Assessment';
          } else if (event.summary.toLowerCase().includes('(e-lecture')) {
            sessionType = 'E-lecture';
          } else if (event.summary.toLowerCase().includes('(self study)')) {
            sessionType = 'Self study';
          } else if (event.summary.toLowerCase().includes('(self-learning')) {
            sessionType = 'Self learning';
          } else if (event.summary.toLowerCase().includes('(visit)')) {
            sessionType = 'Visit';
          } else if (event.summary.toLowerCase().includes('(lecture)')) {
            sessionType = 'Lecture';
          } else if (event.summary.toLowerCase().includes('(ward rounds)')) {
            sessionType = 'Ward rounds';
          } else if (event.summary.toLowerCase().includes('(attachment)')) {
            sessionType = 'Attachment';
          }
        }

        if (sessionType) {
          if (sessionType.toLowerCase().startsWith('dissection')) {
            sessionType = 'Dissection';
          } else if (sessionType.toLowerCase().startsWith('flipped classroom')) {
            sessionType = 'Flipped classroom';
          }
        }

        let summary;
        if (courseCode) {
          if (sessionType) {
            summary = `${getCourseName(courseCode)} - ${sessionType}`;
          } else {
            summary = `${getCourseName(courseCode)} - UNKNOWN`;
          }
        } else {
          courseCode = 'UNKNOWN';
          summary = `${courseCode} - ${event.summary}`;
        }

        if (filterRegex && !filterRegex.test(courseCode)) {
          return null;
        }

        // for full day events, the end time should exclusive
        if (event.start.getUTCHours() === 16 && event.end.getUTCHours() === 16) {
          event.end.setDate(event.end.getDate() + 1);
        }

        return {
          id: event.uid,
          class: event.class.trim() as ICalEventClass,
          stamp: event.dtstamp,
          start: event.start,
          end: event.end,
          location: event.location,
          sequence: Number(event.sequence),
          summary,
          description: event.summary,
        };
      })
      .filter(Boolean) as ICalEventData[]
  );

  res.setHeader('Content-Type', 'text/calendar').send(calendar.toString());
};
